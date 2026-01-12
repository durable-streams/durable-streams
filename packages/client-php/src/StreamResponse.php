<?php

declare(strict_types=1);

namespace DurableStreams;

use DurableStreams\Exception\DurableStreamException;
use DurableStreams\Internal\HttpClient;
use DurableStreams\Internal\HttpClientInterface;
use DurableStreams\Internal\HttpResponse;
use Generator;
use IteratorAggregate;
use LogicException;

/**
 * Response from a stream read operation.
 *
 * @implements IteratorAggregate<int, string>
 */
final class StreamResponse implements IteratorAggregate
{
    private string $offset;
    private ?string $cursor = null;
    private bool $upToDate = false;
    private int $status;
    private bool $cancelled = false;
    private bool $live;

    /** @var string|null Buffered response body for non-live reads */
    private ?string $body = null;

    /** @var array<string, string|callable> Headers (static or dynamic) */
    private array $headers;

    /** @var (callable(DurableStreamException): ?array)|null Error handler */
    private $onError;

    /**
     * @param string $url Stream URL
     * @param string $initialOffset Starting offset
     * @param string|false $liveMode Live mode: false, 'long-poll', or 'sse'
     * @param array<string, string|callable> $headers Request headers (values can be callables)
     * @param HttpClientInterface $client HTTP client
     * @param float $timeout Request timeout
     * @param (callable(DurableStreamException): ?array)|null $onError Error handler
     */
    public function __construct(
        private readonly string $url,
        string $initialOffset,
        private readonly string|false $liveMode,
        array $headers,
        private HttpClientInterface $client,
        private float $timeout,
        ?callable $onError = null,
    ) {
        $this->offset = $initialOffset;
        $this->live = $liveMode !== false;
        $this->status = 0;
        $this->headers = $headers;
        $this->onError = $onError;
    }

    /**
     * Get the current offset.
     */
    public function getOffset(): string
    {
        return $this->offset;
    }

    /**
     * Check if stream is up-to-date.
     */
    public function isUpToDate(): bool
    {
        return $this->upToDate;
    }

    /**
     * Check if this is a live (infinite) stream.
     */
    public function isLive(): bool
    {
        return $this->live;
    }

    /**
     * Get the HTTP status code.
     */
    public function getStatus(): int
    {
        return $this->status;
    }

    /**
     * Cancel the read session (soft cancel - stops after current request).
     */
    public function cancel(): void
    {
        $this->cancelled = true;
    }

    /**
     * Resolve headers, evaluating any callable values.
     *
     * @return array<string, string>
     * @throws DurableStreamException if a header callable fails
     */
    private function resolveHeaders(): array
    {
        $resolved = [];
        foreach ($this->headers as $name => $value) {
            if (is_callable($value)) {
                try {
                    $result = $value();
                    if (!is_string($result)) {
                        throw new DurableStreamException(
                            sprintf("Header callable for '%s' returned %s, expected string", $name, gettype($result)),
                            'INVALID_HEADER_VALUE'
                        );
                    }
                    $resolved[$name] = $result;
                } catch (DurableStreamException $e) {
                    throw $e;
                } catch (\Throwable $e) {
                    throw new DurableStreamException(
                        sprintf("Failed to resolve header '%s': %s", $name, $e->getMessage()),
                        'HEADER_RESOLUTION_FAILED',
                        null,
                        [],
                        $e
                    );
                }
            } else {
                $resolved[$name] = $value;
            }
        }
        return $resolved;
    }

    /**
     * Apply options returned from onError callback.
     *
     * @param array<string, mixed> $options
     */
    private function applyErrorOptions(array $options): void
    {
        if (isset($options['headers'])) {
            $this->headers = array_merge($this->headers, $options['headers']);
        }
        if (isset($options['timeout'])) {
            $this->timeout = (float) $options['timeout'];
        }
        if (isset($options['client']) && $options['client'] instanceof HttpClientInterface) {
            $this->client = $options['client'];
        }
    }

    /**
     * Fetch the next chunk of data.
     */
    private function fetch(): HttpResponse
    {
        // SSE is not supported in synchronous PHP
        if ($this->liveMode === 'sse') {
            throw new LogicException('SSE mode is not supported. Use long-poll instead.');
        }

        $url = $this->url;
        $query = [];

        $query['offset'] = $this->offset;

        if ($this->liveMode !== false) {
            $query['live'] = $this->liveMode;
        }

        if ($this->cursor !== null) {
            $query['cursor'] = $this->cursor;
        }

        if (!empty($query)) {
            $url .= '?' . http_build_query($query);
        }

        // Resolve dynamic headers
        $resolvedHeaders = $this->resolveHeaders();

        try {
            return $this->client->get($url, $resolvedHeaders, $this->timeout);
        } catch (DurableStreamException $e) {
            // If we have an error handler, give it a chance to recover
            if ($this->onError !== null) {
                $result = ($this->onError)($e);

                if ($result !== null) {
                    // Apply returned options and retry
                    $this->applyErrorOptions($result);
                    $resolvedHeaders = $this->resolveHeaders();
                    return $this->client->get($url, $resolvedHeaders, $this->timeout);
                }
            }

            // No recovery - rethrow
            throw $e;
        }
    }

    /**
     * Update internal state from response.
     */
    private function updateFromResponse(HttpResponse $response): void
    {
        $this->status = $response->status;

        if ($response->getOffset() !== null) {
            $this->offset = $response->getOffset();
        }

        if ($response->getCursor() !== null) {
            $this->cursor = $response->getCursor();
        }

        $this->upToDate = $response->isUpToDate();
    }

    /**
     * Iterate over raw body chunks.
     *
     * For live mode (long-poll), yields after each fetch even if empty.
     * This allows the consumer to check isUpToDate() and cancel().
     *
     * @return Generator<int, string>
     */
    public function getIterator(): Generator
    {
        // Initial fetch
        $response = $this->fetch();
        $this->updateFromResponse($response);

        if ($response->status !== 204 && $response->body !== '') {
            yield $response->body;
        }

        // For non-live mode, stop after initial fetch
        if (!$this->live) {
            return;
        }

        // For live mode, yield empty string to give consumer a chance
        // to check state (isUpToDate, getOffset) and cancel if needed.
        // Consumer should call cancel() when they want to stop iteration.
        yield '';

        // Continue polling for live mode until cancelled
        while (!$this->cancelled) {
            $response = $this->fetch();
            $this->updateFromResponse($response);

            if ($response->status !== 204 && $response->body !== '') {
                yield $response->body;
            } else {
                // Yield empty string to allow state check
                yield '';
            }
        }
    }

    /**
     * Iterate over individual JSON items.
     *
     * @return Generator<int, mixed>
     */
    public function jsonStream(): Generator
    {
        foreach ($this as $chunk) {
            // Skip empty chunks (yielded for state checking in live mode)
            if ($chunk === '') {
                continue;
            }

            // Parse JSON array or single values
            $data = json_decode($chunk, true, 512, JSON_THROW_ON_ERROR);

            if (is_array($data) && array_is_list($data)) {
                foreach ($data as $item) {
                    yield $item;
                }
            } else {
                yield $data;
            }
        }
    }

    /**
     * Read all data as bytes.
     *
     * @throws LogicException if called on a live stream
     */
    public function readBytes(): string
    {
        if ($this->live) {
            throw new LogicException('Cannot call readBytes() on a live stream - it would block forever');
        }

        if ($this->body !== null) {
            return $this->body;
        }

        $chunks = [];
        foreach ($this as $chunk) {
            $chunks[] = $chunk;
        }

        $this->body = implode('', $chunks);
        return $this->body;
    }

    /**
     * Collect all JSON items into an array.
     *
     * @return array<mixed>
     * @throws LogicException if called on a live stream
     */
    public function json(): array
    {
        if ($this->live) {
            throw new LogicException('Cannot call json() on a live stream - it would block forever');
        }

        $items = [];
        foreach ($this->jsonStream() as $item) {
            $items[] = $item;
        }

        return $items;
    }

    /**
     * Collect full body as string.
     *
     * @throws LogicException if called on a live stream
     */
    public function body(): string
    {
        return $this->readBytes();
    }
}
