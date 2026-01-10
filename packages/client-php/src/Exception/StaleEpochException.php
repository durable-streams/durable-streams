<?php

declare(strict_types=1);

namespace DurableStreams\Exception;

class StaleEpochException extends DurableStreamException
{
    public function __construct(
        protected int $currentEpoch,
        ?\Throwable $previous = null,
    ) {
        parent::__construct(
            "Stale epoch, current server epoch is {$currentEpoch}",
            'STALE_EPOCH',
            403,
            [],
            $previous
        );
    }

    public function getCurrentEpoch(): int
    {
        return $this->currentEpoch;
    }
}
