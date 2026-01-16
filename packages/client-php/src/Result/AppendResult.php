<?php

declare(strict_types=1);

namespace DurableStreams\Result;

/**
 * Result of an append operation.
 */
final class AppendResult
{
    public function __construct(
        public readonly string $offset,
        public readonly int $status = 200,
        public readonly bool $duplicate = false,
    ) {}
}
