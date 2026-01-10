<?php

declare(strict_types=1);

namespace DurableStreams\Exception;

class MessageTooLargeException extends DurableStreamException
{
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
}
