<?php

declare(strict_types=1);

namespace DurableStreams\Exception;

/**
 * Thrown when rate limited (HTTP 429).
 */
class RateLimitedException extends DurableStreamException
{
    private ?int $retryAfter;

    public function __construct(
        string $message = 'Rate limited',
        array $headers = [],
        ?\Throwable $previous = null,
    ) {
        parent::__construct($message, 'RATE_LIMITED', 429, $headers, $previous);

        // Parse Retry-After header if present
        $this->retryAfter = isset($headers['retry-after'])
            ? (int) $headers['retry-after']
            : null;
    }

    /**
     * Get the suggested retry delay in seconds, if provided.
     */
    public function getRetryAfter(): ?int
    {
        return $this->retryAfter;
    }
}
