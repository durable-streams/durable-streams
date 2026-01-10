<?php

declare(strict_types=1);

namespace DurableStreams\Exception;

/**
 * Base exception for all Durable Streams errors.
 */
class DurableStreamException extends \Exception
{
    public function __construct(
        string $message,
        protected ?string $errorCode = null,
        protected ?int $httpStatus = null,
        protected array $headers = [],
        ?\Throwable $previous = null,
    ) {
        parent::__construct($message, 0, $previous);
    }

    public function getErrorCode(): ?string
    {
        return $this->errorCode;
    }

    public function getHttpStatus(): ?int
    {
        return $this->httpStatus;
    }

    public function getHeaders(): array
    {
        return $this->headers;
    }

    public function isRetryable(): bool
    {
        return in_array($this->httpStatus, [429, 500, 502, 503, 504], true);
    }
}
