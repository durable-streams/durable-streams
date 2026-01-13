<?php

declare(strict_types=1);

namespace DurableStreams;

/**
 * A chunk of data from a stream read operation.
 *
 * Each chunk represents one HTTP response from the server, containing:
 * - The data (if any)
 * - The offset after this chunk (for checkpointing)
 * - Whether the stream is caught up
 * - The HTTP status code
 *
 * In live mode, chunks with null data are yielded to allow state inspection
 * and cancellation between long-poll requests.
 */
final class StreamChunk
{
    /**
     * @param string|null $data Raw bytes from this response, or null if no new data
     * @param string $offset The offset after this chunk (use for checkpointing)
     * @param bool $upToDate True if the stream is caught up to head
     * @param int $status HTTP status code (200 for data, 204 for no content)
     * @param string|null $cursor CDN cursor (automatically propagated by iterator)
     */
    public function __construct(
        public readonly ?string $data,
        public readonly string $offset,
        public readonly bool $upToDate,
        public readonly int $status,
        public readonly ?string $cursor = null,
    ) {}

    /**
     * Check if this chunk contains data.
     */
    public function hasData(): bool
    {
        return $this->data !== null && $this->data !== '';
    }
}
