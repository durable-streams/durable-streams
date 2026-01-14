<?php

declare(strict_types=1);

namespace DurableStreams\Result;

/**
 * Result of a HEAD request.
 */
final class HeadResult
{
    public function __construct(
        public readonly string $offset,
        public readonly ?string $contentType = null,
        public readonly ?int $ttlSeconds = null,
        public readonly ?string $expiresAt = null,
    ) {}
}
