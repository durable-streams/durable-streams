<?php

declare(strict_types=1);

namespace DurableStreams\Exception;

class StreamExistsException extends DurableStreamException
{
    public function __construct(string $url, ?\Throwable $previous = null)
    {
        parent::__construct(
            "Stream already exists: {$url}",
            'CONFLICT_EXISTS',
            409,
            [],
            $previous
        );
    }
}
