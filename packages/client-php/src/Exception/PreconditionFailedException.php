<?php

declare(strict_types=1);

namespace DurableStreams\Exception;

/**
 * Exception thrown when an If-Match precondition fails (412 response).
 *
 * This occurs when using optimistic concurrency control and another writer
 * has modified the stream since the last read.
 */
class PreconditionFailedException extends DurableStreamException
{
    public function __construct(
        private ?string $currentETag = null,
        private ?string $currentOffset = null,
        private bool $streamClosed = false,
        array $headers = [],
        ?\Throwable $previous = null,
    ) {
        parent::__construct(
            'Precondition failed: stream was modified by another writer',
            'PRECONDITION_FAILED',
            412,
            $headers,
            $previous
        );
    }

    /**
     * Get the current ETag of the stream.
     */
    public function getCurrentETag(): ?string
    {
        return $this->currentETag;
    }

    /**
     * Get the current tail offset of the stream.
     */
    public function getCurrentOffset(): ?string
    {
        return $this->currentOffset;
    }

    /**
     * Check if the stream is closed.
     */
    public function isStreamClosed(): bool
    {
        return $this->streamClosed;
    }
}
