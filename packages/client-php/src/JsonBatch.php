<?php

declare(strict_types=1);

namespace DurableStreams;

use Countable;

/**
 * A batch of JSON items from a stream read operation.
 *
 * Each batch represents one HTTP response, containing:
 * - The parsed JSON items
 * - The offset after this batch (for checkpointing)
 * - Whether the stream is caught up
 *
 * This mirrors the TypeScript client's `subscribeJson` callback pattern,
 * making it easy to translate examples across languages.
 *
 * @template T The type of items in this batch
 */
final class JsonBatch implements Countable
{
    /**
     * @param array<int, T> $items Parsed JSON items from this response
     * @param string $offset The offset after this batch (use for checkpointing)
     * @param bool $upToDate True if the stream is caught up to head
     * @param int $status HTTP status code
     */
    public function __construct(
        public readonly array $items,
        public readonly string $offset,
        public readonly bool $upToDate,
        public readonly int $status = 200,
    ) {}

    /**
     * Check if this batch contains items.
     */
    public function hasItems(): bool
    {
        return count($this->items) > 0;
    }

    /**
     * Get the number of items in this batch.
     */
    public function count(): int
    {
        return count($this->items);
    }
}
