<?php

declare(strict_types=1);

namespace DurableStreams\Internal;

/**
 * HTTP response wrapper.
 */
final class HttpResponse
{
    /**
     * @param int $status HTTP status code
     * @param array<string, string> $headers Response headers (lowercase keys)
     * @param string $body Response body
     */
    public function __construct(
        public readonly int $status,
        public readonly array $headers,
        public readonly string $body,
    ) {}

    /**
     * Get a header value (case-insensitive).
     */
    public function getHeader(string $name): ?string
    {
        return $this->headers[strtolower($name)] ?? null;
    }

    /**
     * Get stream offset from response headers.
     */
    public function getOffset(): ?string
    {
        return $this->getHeader('stream-next-offset');
    }

    /**
     * Get stream cursor from response headers.
     */
    public function getCursor(): ?string
    {
        return $this->getHeader('stream-cursor');
    }

    /**
     * Check if stream is up-to-date.
     */
    public function isUpToDate(): bool
    {
        return $this->getHeader('stream-up-to-date') === 'true';
    }

    /**
     * Get content type from response headers (full value with parameters).
     */
    public function getContentType(): ?string
    {
        return $this->getHeader('content-type');
    }

    /**
     * Get media type only (content-type without parameters like charset).
     */
    public function getMediaType(): ?string
    {
        $ct = $this->getHeader('content-type');
        if ($ct === null) {
            return null;
        }
        $parts = explode(';', $ct);
        return trim($parts[0]);
    }
}
