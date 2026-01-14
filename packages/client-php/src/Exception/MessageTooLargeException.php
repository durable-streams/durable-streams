<?php

declare(strict_types=1);

namespace DurableStreams\Exception;

class MessageTooLargeException extends DurableStreamException
{
    /**
     * Create exception for local validation failure.
     */
    public function __construct(int $size, int $maxSize, ?\Throwable $previous = null)
    {
        parent::__construct(
            "Item size ({$size} bytes) exceeds maxBatchBytes ({$maxSize})",
            'MESSAGE_TOO_LARGE',
            null,
            [],
            $previous
        );
    }

    /**
     * Create exception from server 413 response.
     *
     * @param string $message Error message from server
     * @param array<string, string> $headers Response headers
     */
    public static function fromServerResponse(string $message, array $headers = []): self
    {
        $e = new self(0, 0);
        // Re-initialize with server context
        $e->message = $message ?: 'Payload too large';
        $e->httpStatus = 413;
        $e->headers = $headers;
        return $e;
    }
}
