<?php

declare(strict_types=1);

namespace DurableStreams\Internal;

use DurableStreams\Exception\DurableStreamException;
use DurableStreams\Exception\RateLimitedException;
use DurableStreams\Exception\SeqConflictException;
use DurableStreams\Exception\StreamExistsException;
use DurableStreams\Exception\StreamNotFoundException;
use DurableStreams\Exception\UnauthorizedException;
use DurableStreams\RetryOptions;
use Psr\Http\Client\ClientExceptionInterface;
use Psr\Http\Client\ClientInterface;
use Psr\Http\Message\RequestFactoryInterface;
use Psr\Http\Message\StreamFactoryInterface;

/**
 * PSR-18 HTTP client adapter for Durable Streams.
 *
 * Wraps a PSR-18 compliant HTTP client, adding retry logic and
 * error handling consistent with the built-in cURL client.
 */
final class Psr18HttpClient implements HttpClientInterface
{
    private RetryOptions $retryOptions;

    public function __construct(
        private readonly ClientInterface $client,
        private readonly RequestFactoryInterface $requestFactory,
        private readonly StreamFactoryInterface $streamFactory,
        ?RetryOptions $retryOptions = null,
    ) {
        $this->retryOptions = $retryOptions ?? RetryOptions::default();
    }

    public function request(
        string $method,
        string $url,
        array $headers = [],
        ?string $body = null,
        ?float $timeout = null,
    ): HttpResponse {
        $maxRetries = $this->retryOptions->maxRetries;
        $lastException = null;
        $lastResponse = null;

        for ($attempt = 0; $attempt <= $maxRetries; $attempt++) {
            // Exponential backoff using configured options
            $delayMs = $this->retryOptions->delayForAttempt($attempt);
            if ($delayMs > 0) {
                usleep($delayMs * 1000);
            }

            try {
                $response = $this->doRequest($method, $url, $headers, $body);
                $status = $response->status;

                // Check if this is a retryable status
                if ($this->isRetryableStatus($status) && $attempt < $maxRetries) {
                    $lastResponse = $response;
                    continue;
                }

                // Handle error status codes (throws for non-retryable errors)
                $this->handleErrorStatus($status, $url, $response->headers, $response->body);

                return $response;
            } catch (DurableStreamException $e) {
                // Network errors and timeouts are retryable
                if ($e->getErrorCode() === 'NETWORK_ERROR' && $attempt < $maxRetries) {
                    $lastException = $e;
                    continue;
                }
                throw $e;
            }
        }

        // All retries exhausted - throw last error
        if ($lastException !== null) {
            throw $lastException;
        }

        if ($lastResponse !== null) {
            $this->handleErrorStatus($lastResponse->status, $url, $lastResponse->headers, $lastResponse->body);
        }

        throw new DurableStreamException('Request failed after retries', 'NETWORK_ERROR');
    }

    private function doRequest(
        string $method,
        string $url,
        array $headers,
        ?string $body,
    ): HttpResponse {
        $request = $this->requestFactory->createRequest($method, $url);

        foreach ($headers as $name => $value) {
            $request = $request->withHeader($name, $value);
        }

        if ($body !== null) {
            $stream = $this->streamFactory->createStream($body);
            $request = $request->withBody($stream);
        }

        try {
            $response = $this->client->sendRequest($request);
        } catch (ClientExceptionInterface $e) {
            throw new DurableStreamException(
                "Network error: {$e->getMessage()}",
                'NETWORK_ERROR',
                null,
                [],
                $e
            );
        }

        $statusCode = $response->getStatusCode();
        $responseHeaders = [];
        foreach ($response->getHeaders() as $name => $values) {
            $responseHeaders[strtolower($name)] = implode(', ', $values);
        }
        $responseBody = (string) $response->getBody();

        return new HttpResponse($statusCode, $responseHeaders, $responseBody);
    }

    private function isRetryableStatus(int $status): bool
    {
        return in_array($status, [429, 500, 502, 503, 504], true);
    }

    private function handleErrorStatus(int $status, string $url, array $headers, string $body): void
    {
        if ($status >= 200 && $status < 300) {
            return;
        }

        if ($status === 204) {
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
                    throw new SeqConflictException($body ?: 'Sequence conflict', null, null, $headers);
                }

                throw new StreamExistsException($url);

            case 400:
                throw new DurableStreamException($body ?: 'Bad request', 'BAD_REQUEST', $status, $headers);

            case 401:
                throw new UnauthorizedException($body ?: 'Unauthorized', $headers);

            case 403:
                throw new DurableStreamException($body ?: 'Forbidden', 'FORBIDDEN', $status, $headers);

            case 429:
                throw new RateLimitedException($body ?: 'Rate limited', $headers);

            default:
                if ($status >= 500) {
                    throw new DurableStreamException("Server error: {$status}", 'SERVER_ERROR', $status, $headers);
                }
                throw new DurableStreamException("Unexpected status: {$status}", 'UNEXPECTED_STATUS', $status, $headers);
        }
    }

    public function get(string $url, array $headers = [], ?float $timeout = null): HttpResponse
    {
        return $this->request('GET', $url, $headers, null, $timeout);
    }

    public function post(string $url, string $body, array $headers = []): HttpResponse
    {
        return $this->request('POST', $url, $headers, $body);
    }

    public function put(string $url, array $headers = [], ?string $body = null): HttpResponse
    {
        return $this->request('PUT', $url, $headers, $body);
    }

    public function head(string $url, array $headers = []): HttpResponse
    {
        return $this->request('HEAD', $url, $headers);
    }

    public function delete(string $url, array $headers = []): HttpResponse
    {
        return $this->request('DELETE', $url, $headers);
    }
}
