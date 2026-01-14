<?php

declare(strict_types=1);

namespace DurableStreams;

/**
 * Configuration for retry behavior with exponential backoff.
 */
final class RetryOptions
{
    public function __construct(
        public readonly int $maxRetries = 3,
        public readonly int $initialDelayMs = 100,
        public readonly int $maxDelayMs = 5000,
        public readonly float $multiplier = 2.0,
    ) {
        if ($maxRetries < 0) {
            throw new \InvalidArgumentException('maxRetries must be >= 0');
        }
        if ($initialDelayMs <= 0) {
            throw new \InvalidArgumentException('initialDelayMs must be > 0');
        }
        if ($maxDelayMs < $initialDelayMs) {
            throw new \InvalidArgumentException('maxDelayMs must be >= initialDelayMs');
        }
        if ($multiplier < 1.0) {
            throw new \InvalidArgumentException('multiplier must be >= 1.0');
        }
    }

    /**
     * Create default retry options.
     */
    public static function default(): self
    {
        return new self();
    }

    /**
     * Create options with no retries.
     */
    public static function none(): self
    {
        return new self(maxRetries: 0);
    }

    /**
     * Calculate delay for a given attempt (0-indexed).
     *
     * @return int Delay in milliseconds
     */
    public function delayForAttempt(int $attempt): int
    {
        if ($attempt <= 0) {
            return 0;
        }

        $delay = (int) ($this->initialDelayMs * pow($this->multiplier, $attempt - 1));
        return min($delay, $this->maxDelayMs);
    }
}
