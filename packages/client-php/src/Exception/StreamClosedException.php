<?php

declare(strict_types=1);

namespace DurableStreams\Exception;

/**
 * Exception thrown when attempting to append to a closed stream.
 */
class StreamClosedException extends DurableStreamException
{
    public function __construct(string $url = null, ?\Throwable $previous = null)
    {
        $message = $url ? "Stream is closed: {$url}" : "Stream is closed";
        parent::__construct($message, 'STREAM_CLOSED', 409, [], $previous);
    }
}
