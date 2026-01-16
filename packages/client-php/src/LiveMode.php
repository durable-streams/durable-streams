<?php

declare(strict_types=1);

namespace DurableStreams;

/**
 * Live streaming mode for stream reads.
 *
 * Controls how the client behaves when caught up to the stream head:
 * - Off: Stop when caught up (catch-up mode)
 * - LongPoll: Keep polling for new data (blocks until data arrives or timeout)
 */
enum LiveMode: string
{
    /**
     * Catch-up mode: stop when caught up to stream head.
     */
    case Off = 'off';

    /**
     * Long-poll mode: block until new data arrives or timeout.
     */
    case LongPoll = 'long-poll';

    /**
     * Convert to the wire format for query parameters.
     *
     * Returns false for Off mode (omit from query), string otherwise.
     */
    public function toQueryValue(): string|false
    {
        return match ($this) {
            self::Off => false,
            self::LongPoll => 'long-poll',
        };
    }

    /**
     * Check if this is a live (infinite) mode.
     */
    public function isLive(): bool
    {
        return $this !== self::Off;
    }
}
