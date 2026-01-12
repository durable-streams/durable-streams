<?php

declare(strict_types=1);

namespace DurableStreams\Exception;

/**
 * Thrown when authentication fails (HTTP 401).
 */
class UnauthorizedException extends DurableStreamException
{
    public function __construct(
        string $message = 'Unauthorized',
        array $headers = [],
        ?\Throwable $previous = null,
    ) {
        parent::__construct($message, 'UNAUTHORIZED', 401, $headers, $previous);
    }
}
