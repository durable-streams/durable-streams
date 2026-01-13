<?php

declare(strict_types=1);

namespace DurableStreams\Internal;

use DurableStreams\Exception\DurableStreamException;
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
 *
 * **Note:** The `$timeout` parameter is accepted for interface compatibility but
 * is ignored. PSR-18 does not standardize per-request timeouts - configure
 * timeouts on the underlying PSR-18 client instead.
 */
final class Psr18HttpClient implements HttpClientInterface
{
    use HttpErrorHandler;

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
                $errorCode = $e->getErrorCode();
                if (($errorCode === 'NETWORK_ERROR' || $errorCode === 'TIMEOUT') && $attempt < $maxRetries) {
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
