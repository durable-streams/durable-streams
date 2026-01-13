<?php

declare(strict_types=1);

namespace DurableStreams;

use ArrayIterator;
use Countable;
use IteratorAggregate;
use Traversable;

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
 * Implements IteratorAggregate so you can iterate directly:
 * ```php
 * foreach ($batch as $item) { ... }
 * ```
 *
 * @template T The type of items in this batch
 * @implements IteratorAggregate<int, T>
 */
final class JsonBatch implements Countable, IteratorAggregate
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

    /**
     * Get an iterator over the items.
     *
     * @return Traversable<int, T>
     */
    public function getIterator(): Traversable
    {
        return new ArrayIterator($this->items);
    }
}
