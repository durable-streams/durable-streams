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
     * @param LiveMode $liveMode Live mode
     * @param array<string, string|callable> $headers Request headers (values can be callables)
     * @param HttpClientInterface $client HTTP client
     * @param float $timeout Request timeout
     * @param (callable(DurableStreamException): ?array)|null $onError Error handler
     */
    public function __construct(
        private readonly string $url,
        string $initialOffset,
        private readonly LiveMode $liveMode,
        array $headers,
        private HttpClientInterface $client,
        private float $timeout,
        ?callable $onError = null,
    ) {
        $this->offset = $initialOffset;
        $this->live = $liveMode->isLive();
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
        $url = $this->url;
        $query = [];

        $query['offset'] = $this->offset;

        $liveQueryValue = $this->liveMode->toQueryValue();
        if ($liveQueryValue !== false) {
            $query['live'] = $liveQueryValue;
        }

        if ($this->cursor !== null) {
            $query['cursor'] = $this->cursor;
        }

        $url .= '?' . http_build_query($query);

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
     * Iterate over typed chunks (recommended API).
     *
     * Each chunk represents one HTTP response from the server. In live mode,
     * chunks are yielded even when there's no new data, allowing you to:
     * - Check the current offset for checkpointing
     * - Inspect upToDate status
     * - Call cancel() to stop iteration
     *
     * Example:
     * ```php
     * foreach ($response->chunks() as $chunk) {
     *     if ($chunk->hasData()) {
     *         processData($chunk->data);
     *     }
     *     saveCheckpoint($chunk->offset);
     * }
     * ```
     *
     * @return Generator<int, StreamChunk>
     */
    public function chunks(): Generator
    {
        // Initial fetch
        $response = $this->fetch();
        $this->updateFromResponse($response);

        $data = ($response->status !== 204 && $response->body !== '')
            ? $response->body
            : null;

        yield new StreamChunk(
            data: $data,
            offset: $this->offset,
            upToDate: $this->upToDate,
            status: $response->status,
            cursor: $this->cursor,
        );

        // For non-live mode, continue until caught up (upToDate is true)
        if (!$this->live) {
            while (!$this->upToDate && !$this->cancelled) {
                $response = $this->fetch();
                $this->updateFromResponse($response);

                $data = ($response->status !== 204 && $response->body !== '')
                    ? $response->body
                    : null;

                yield new StreamChunk(
                    data: $data,
                    offset: $this->offset,
                    upToDate: $this->upToDate,
                    status: $response->status,
                    cursor: $this->cursor,
                );
            }
            return;
        }

        // Continue polling for live mode until cancelled
        while (!$this->cancelled) {
            $response = $this->fetch();
            $this->updateFromResponse($response);

            $data = ($response->status !== 204 && $response->body !== '')
                ? $response->body
                : null;

            yield new StreamChunk(
                data: $data,
                offset: $this->offset,
                upToDate: $this->upToDate,
                status: $response->status,
                cursor: $this->cursor,
            );
        }
    }

    /**
     * Iterate over JSON batches (recommended for JSON streams).
     *
     * Each batch represents one HTTP response, containing all items from that
     * response plus metadata. This matches the TypeScript client's subscribeJson
     * pattern, making it easy to translate examples across languages.
     *
     * Example:
     * ```php
     * foreach ($response->jsonBatches() as $batch) {
     *     foreach ($batch->items as $item) {
     *         processItem($item);
     *     }
     *     saveCheckpoint($batch->offset);
     * }
     * ```
     *
     * @return Generator<int, JsonBatch>
     */
    public function jsonBatches(): Generator
    {
        foreach ($this->chunks() as $chunk) {
            $items = [];

            if ($chunk->hasData()) {
                $data = json_decode($chunk->data, true, 512, JSON_THROW_ON_ERROR);

                if (is_array($data) && array_is_list($data)) {
                    $items = $data;
                } else {
                    $items = [$data];
                }
            }

            yield new JsonBatch(
                items: $items,
                offset: $chunk->offset,
                upToDate: $chunk->upToDate,
                status: $chunk->status,
            );
        }
    }

    /**
     * Iterate over raw body strings.
     *
     * Note: In live mode, empty strings are yielded between HTTP responses
     * to allow state checking. Consider using chunks() instead for a cleaner API.
     *
     * @return Generator<int, string>
     */
    public function getIterator(): Generator
    {
        foreach ($this->chunks() as $chunk) {
            if ($chunk->hasData()) {
                yield $chunk->data;
            } elseif ($this->live) {
                // Yield empty string in live mode for backwards compatibility
                yield '';
            }
        }
    }

    /**
     * Iterate over individual JSON items.
     *
     * Note: This yields items one-by-one without batch boundaries.
     * Consider using jsonBatches() instead for checkpointing support.
     *
     * @return Generator<int, mixed>
     */
    public function jsonStream(): Generator
    {
        foreach ($this->jsonBatches() as $batch) {
            foreach ($batch->items as $item) {
                yield $item;
            }
        }
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
        if ($this->live) {
            throw new LogicException('Cannot call body() on a live stream - it would block forever');
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
}
