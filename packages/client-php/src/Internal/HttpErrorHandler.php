<?php

declare(strict_types=1);

namespace DurableStreams\Internal;

use DurableStreams\Exception\DurableStreamException;
use DurableStreams\Exception\MessageTooLargeException;
use DurableStreams\Exception\RateLimitedException;
use DurableStreams\Exception\SeqConflictException;
use DurableStreams\Exception\StreamExistsException;
use DurableStreams\Exception\StreamNotFoundException;
use DurableStreams\Exception\UnauthorizedException;

/**
 * Shared HTTP error handling logic for HTTP clients.
 */
trait HttpErrorHandler
{
    /**
     * Check if an HTTP status code is retryable.
     */
    private function isRetryableStatus(int $status): bool
    {
        return in_array($status, [429, 500, 502, 503, 504], true);
    }

    /**
     * Handle HTTP error status codes.
     *
     * @param int $status HTTP status code
     * @param string $url Request URL
     * @param array<string, string> $headers Response headers
     * @param string $body Response body
     * @throws DurableStreamException
     */
    private function handleErrorStatus(int $status, string $url, array $headers, string $body): void
    {
        if ($status >= 200 && $status < 300) {
            return;
        }

        switch ($status) {
            case 404:
                throw new StreamNotFoundException($url);

            case 409:
                $expectedSeq = isset($headers['producer-expected-seq'])
                    ? (int) $headers['producer-expected-seq']
                    : null;
                $receivedSeq = isset($headers['producer-received-seq'])
                    ? (int) $headers['producer-received-seq']
                    : null;

                if ($expectedSeq !== null || $receivedSeq !== null) {
                    throw new SeqConflictException(
                        "Sequence conflict: expected {$expectedSeq}, received {$receivedSeq}",
                        $expectedSeq,
                        $receivedSeq,
                        $headers
                    );
                }

                if (stripos($body, 'sequence conflict') !== false) {
                    throw new SeqConflictException($body, null, null, $headers);
                }

                throw new StreamExistsException($url);

            case 400:
                throw new DurableStreamException($body ?: 'Bad request', 'BAD_REQUEST', $status, $headers);

            case 401:
                throw new UnauthorizedException($body ?: 'Unauthorized', $headers);

            case 403:
                throw new DurableStreamException($body ?: 'Forbidden', 'FORBIDDEN', $status, $headers);

            case 413:
                throw MessageTooLargeException::fromServerResponse($body, $headers);

            case 429:
                throw new RateLimitedException($body ?: 'Rate limited', $headers);

            default:
                if ($status >= 500) {
                    throw new DurableStreamException("Server error: {$status}", 'SERVER_ERROR', $status, $headers);
                }
                throw new DurableStreamException("Unexpected status: {$status}", 'UNEXPECTED_STATUS', $status, $headers);
        }
    }
}
