<?php

declare(strict_types=1);

namespace DurableStreams\Exception;

class StreamNotFoundException extends DurableStreamException
{
    public function __construct(string $url, ?\Throwable $previous = null)
    {
        parent::__construct(
            "Stream not found: {$url}",
            'NOT_FOUND',
            404,
            [],
            $previous
        );
    }
}
