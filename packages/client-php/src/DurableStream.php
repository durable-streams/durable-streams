<?php

declare(strict_types=1);

namespace DurableStreams;

use DurableStreams\Exception\DurableStreamException;
use DurableStreams\Internal\HttpClient;
use DurableStreams\Internal\HttpClientInterface;
use DurableStreams\Result\AppendResult;
use DurableStreams\Result\HeadResult;

/**
 * Handle for interacting with a Durable Stream.
 */
final class DurableStream
{
    private HttpClientInterface $client;
    private ?string $contentType;

    /** @var array<string, string> */
    private array $headers;

    /**
     * @param string $url Full URL of the stream
     * @param string|null $contentType Content type (auto-detected if not provided)
     * @param array<string, string> $headers Additional headers to send with each request
     * @param HttpClientInterface|null $client HTTP client (created if not provided)
     */
    public function __construct(
        private readonly string $url,
        ?string $contentType = null,
        array $headers = [],
        ?HttpClientInterface $client = null,
    ) {
        $this->client = $client ?? new HttpClient();
        $this->contentType = $contentType;
        $this->headers = $headers;
    }

    /**
     * Create a new stream.
     *
     * @param string $url Full URL for the stream
     * @param string $contentType Content type for the stream
     * @param array<string, string> $headers Additional headers
     * @param int|null $ttlSeconds Optional TTL in seconds
     * @param string|null $expiresAt Optional absolute expiry (ISO 8601)
     * @param HttpClientInterface|null $client HTTP client to use
     * @return self
     */
    public static function create(
        string $url,
        string $contentType = 'application/octet-stream',
        array $headers = [],
        ?int $ttlSeconds = null,
        ?string $expiresAt = null,
        ?HttpClientInterface $client = null,
    ): self {
        $httpClient = $client ?? new HttpClient();

        $requestHeaders = array_merge($headers, [
            'Content-Type' => $contentType,
        ]);

        if ($ttlSeconds !== null) {
            $requestHeaders['Stream-TTL'] = (string)$ttlSeconds;
        }

        if ($expiresAt !== null) {
            $requestHeaders['Stream-Expires-At'] = $expiresAt;
        }

        $httpClient->put($url, $requestHeaders);

        return new self($url, $contentType, $headers, $httpClient);
    }

    /**
     * Connect to an existing stream.
     *
     * @param string $url Full URL of the stream
     * @param array<string, string> $headers Additional headers
     * @param HttpClientInterface|null $client HTTP client to use
     * @return self
     */
    public static function connect(
        string $url,
        array $headers = [],
        ?HttpClientInterface $client = null,
    ): self {
        $stream = new self($url, null, $headers, $client);
        // Validate the stream exists and get content type
        $head = $stream->head();
        $stream->contentType = $head->contentType;
        return $stream;
    }

    /**
     * Get stream metadata.
     */
    public function head(): HeadResult
    {
        $response = $this->client->head($this->url, $this->headers);

        return new HeadResult(
            offset: $response->getOffset() ?? '-1',
            contentType: $response->getContentType(),
        );
    }

    /**
     * Static HEAD request without creating a stream instance.
     *
     * @param string $url Full URL of the stream
     * @param array<string, string>|null $headers Additional headers
     * @param HttpClientInterface|null $client HTTP client to use
     */
    public static function headStatic(
        string $url,
        ?array $headers = null,
        ?HttpClientInterface $client = null,
    ): HeadResult {
        $httpClient = $client ?? new HttpClient();
        $response = $httpClient->head($url, $headers ?? []);

        return new HeadResult(
            offset: $response->getOffset() ?? '-1',
            contentType: $response->getContentType(),
        );
    }

    /**
     * Append data to the stream.
     *
     * @param string|array<mixed> $data Data to append (arrays are JSON-encoded)
     * @param string|null $seq Optional sequence number
     * @param array<string, string> $extraHeaders Additional headers for this request
     */
    public function append(
        string|array $data,
        ?string $seq = null,
        array $extraHeaders = [],
    ): AppendResult {
        $headers = array_merge($this->headers, $extraHeaders);

        // Determine content type
        $contentType = $this->contentType ?? 'application/octet-stream';
        $headers['Content-Type'] = $contentType;

        // Encode data
        if (is_array($data)) {
            $body = json_encode($data, JSON_THROW_ON_ERROR);
        } else {
            $body = $data;
        }

        if ($seq !== null) {
            $headers['Stream-Seq'] = $seq;
        }

        $response = $this->client->post($this->url, $body, $headers);

        return new AppendResult(
            offset: $response->getOffset() ?? '-1',
            status: $response->status,
            duplicate: $response->status === 204,
        );
    }

    /**
     * Read from the stream.
     *
     * @param string $offset Starting offset
     * @param LiveMode $live Live mode
     * @param array<string, string> $extraHeaders Additional headers
     * @param float|null $timeout Timeout in seconds
     */
    public function read(
        string $offset = '-1',
        LiveMode $live = LiveMode::Off,
        array $extraHeaders = [],
        ?float $timeout = null,
    ): StreamResponse {
        return stream([
            'url' => $this->url,
            'offset' => $offset,
            'live' => $live,
            'headers' => array_merge($this->headers, $extraHeaders),
            'client' => $this->client,
            'timeout' => $timeout,
        ]);
    }

    /**
     * Delete the stream.
     *
     * @param array<string, string>|null $headers Additional headers
     * @param HttpClientInterface|null $client HTTP client to use
     */
    public static function deleteStatic(
        string $url,
        ?array $headers = null,
        ?HttpClientInterface $client = null,
    ): void {
        $httpClient = $client ?? new HttpClient();
        $httpClient->delete($url, $headers ?? []);
    }

    /**
     * Delete this stream.
     */
    public function delete(): void
    {
        $this->client->delete($this->url, $this->headers);
    }

    /**
     * Get the stream URL.
     */
    public function getUrl(): string
    {
        return $this->url;
    }

    /**
     * Get the content type.
     */
    public function getContentType(): ?string
    {
        return $this->contentType;
    }

    /**
     * Close the stream handle.
     */
    public function close(): void
    {
        // Nothing to do - cURL handles are reused
    }
}
