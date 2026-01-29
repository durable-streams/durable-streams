<?php

declare(strict_types=1);

namespace DurableStreams\Result;

/**
 * Result of closing a stream.
 */
final class CloseResult
{
    public function __construct(
        public readonly string $finalOffset,
    ) {}
}
