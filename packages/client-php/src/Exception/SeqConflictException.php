<?php

declare(strict_types=1);

namespace DurableStreams\Exception;

class SeqConflictException extends DurableStreamException
{
    public function __construct(
        string $message,
        protected ?int $expectedSeq = null,
        protected ?int $receivedSeq = null,
        array $headers = [],
        ?\Throwable $previous = null,
    ) {
        parent::__construct($message, 'CONFLICT_SEQ', 409, $headers, $previous);
    }

    public function getExpectedSeq(): ?int
    {
        return $this->expectedSeq;
    }

    public function getReceivedSeq(): ?int
    {
        return $this->receivedSeq;
    }
}
