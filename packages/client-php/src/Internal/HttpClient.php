<?php

declare(strict_types=1);

namespace DurableStreams\Internal;

use DurableStreams\Exception\DurableStreamException;
use DurableStreams\RetryOptions;

/**
 * High-performance HTTP client using cURL.
 *
 * Uses persistent connections via cURL handle reuse for maximum throughput.
 */
final class HttpClient implements HttpClientInterface
{
    use HttpErrorHandler;

    /** @var \CurlHandle|null Reusable cURL handle for connection pooling */
    private ?\CurlHandle $handle = null;

    private float $timeout;
    private float $connectTimeout;
    private RetryOptions $retryOptions;

    public function __construct(
        float $timeout = 30.0,
        float $connectTimeout = 10.0,
        ?RetryOptions $retryOptions = null,
    ) {
        $this->timeout = $timeout;
        $this->connectTimeout = $connectTimeout;
        $this->retryOptions = $retryOptions ?? RetryOptions::default();
    }

    public function __destruct()
    {
        if ($this->handle !== null) {
            curl_close($this->handle);
        }
    }

    /**
     * Get or create the cURL handle for connection reuse.
     */
    private function getHandle(): \CurlHandle
    {
        if ($this->handle === null) {
            $this->handle = curl_init();
            if ($this->handle === false) {
                throw new DurableStreamException('Failed to initialize cURL');
            }

            // Set options that don't change per-request
            curl_setopt_array($this->handle, [
                CURLOPT_RETURNTRANSFER => true,
                CURLOPT_HEADER => true,
                CURLOPT_FOLLOWLOCATION => false,
                CURLOPT_CONNECTTIMEOUT_MS => (int)($this->connectTimeout * 1000),
                CURLOPT_TCP_KEEPALIVE => 1,
                CURLOPT_TCP_KEEPIDLE => 60,
                CURLOPT_TCP_KEEPINTVL => 30,
                // HTTP/1.1 pipelining and connection reuse
                CURLOPT_HTTP_VERSION => CURL_HTTP_VERSION_1_1,
            ]);
        }

        return $this->handle;
    }

    /**
     * Execute an HTTP request with automatic retry for transient errors.
     *
     * @param string $method HTTP method
     * @param string $url Full URL
     * @param array<string, string> $headers Request headers
     * @param string|null $body Request body
     * @param float|null $timeout Override default timeout
     * @return HttpResponse
     */
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
                $response = $this->doRequest($method, $url, $headers, $body, $timeout);
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

        // Should have a response if we got here
        if ($lastResponse !== null) {
            $this->handleErrorStatus($lastResponse->status, $url, $lastResponse->headers, $lastResponse->body);
        }

        throw new DurableStreamException('Request failed after retries', 'NETWORK_ERROR');
    }

    /**
     * Execute a single HTTP request (no retry logic).
     */
    private function doRequest(
        string $method,
        string $url,
        array $headers,
        ?string $body,
        ?float $timeout,
    ): HttpResponse {
        $handle = $this->getHandle();

        // Build header array for cURL
        $curlHeaders = [];
        foreach ($headers as $name => $value) {
            $curlHeaders[] = "{$name}: {$value}";
        }

        // Set request-specific options
        $isHead = $method === 'HEAD';
        $methodsWithBody = ['POST', 'PUT', 'PATCH'];

        curl_setopt_array($handle, [
            CURLOPT_URL => $url,
            CURLOPT_CUSTOMREQUEST => $method,
            CURLOPT_HTTPHEADER => $curlHeaders,
            CURLOPT_TIMEOUT_MS => (int)(($timeout ?? $this->timeout) * 1000),
            CURLOPT_NOBODY => $isHead,
        ]);

        // Only set POSTFIELDS for methods that support a body
        // Setting it on GET/DELETE can cause unexpected cURL behavior
        if (in_array($method, $methodsWithBody, true)) {
            curl_setopt($handle, CURLOPT_POSTFIELDS, $body ?? '');
        } else {
            // Clear any previously set POSTFIELDS for GET/DELETE/HEAD
            curl_setopt($handle, CURLOPT_POSTFIELDS, null);
        }

        // Execute
        $response = curl_exec($handle);

        if ($response === false) {
            $error = curl_error($handle);
            $errno = curl_errno($handle);

            if ($errno === CURLE_OPERATION_TIMEDOUT) {
                throw new DurableStreamException("Request timeout: {$error}", 'TIMEOUT');
            }

            throw new DurableStreamException("Network error: {$error}", 'NETWORK_ERROR');
        }

        // Parse response
        $statusCode = (int)curl_getinfo($handle, CURLINFO_HTTP_CODE);
        $headerSize = (int)curl_getinfo($handle, CURLINFO_HEADER_SIZE);

        $headerStr = substr($response, 0, $headerSize);
        $bodyStr = substr($response, $headerSize);

        $responseHeaders = $this->parseHeaders($headerStr);

        // Return response - error handling is done by the caller
        return new HttpResponse($statusCode, $responseHeaders, $bodyStr);
    }

    /**
     * Parse HTTP response headers.
     *
     * @return array<string, string>
     */
    private function parseHeaders(string $headerStr): array
    {
        $headers = [];
        $lines = explode("\r\n", $headerStr);

        foreach ($lines as $line) {
            if (str_contains($line, ':')) {
                [$name, $value] = explode(':', $line, 2);
                // Use lowercase header names for consistent access
                $headers[strtolower(trim($name))] = trim($value);
            }
        }

        return $headers;
    }

    /**
     * Convenience method for GET requests.
     */
    public function get(string $url, array $headers = [], ?float $timeout = null): HttpResponse
    {
        return $this->request('GET', $url, $headers, null, $timeout);
    }

    /**
     * Convenience method for POST requests.
     */
    public function post(string $url, string $body, array $headers = []): HttpResponse
    {
        return $this->request('POST', $url, $headers, $body);
    }

    /**
     * Convenience method for PUT requests.
     */
    public function put(string $url, array $headers = [], ?string $body = null): HttpResponse
    {
        return $this->request('PUT', $url, $headers, $body);
    }

    /**
     * Convenience method for HEAD requests.
     */
    public function head(string $url, array $headers = []): HttpResponse
    {
        return $this->request('HEAD', $url, $headers);
    }

    /**
     * Convenience method for DELETE requests.
     */
    public function delete(string $url, array $headers = []): HttpResponse
    {
        return $this->request('DELETE', $url, $headers);
    }
}
