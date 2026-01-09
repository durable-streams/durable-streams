<?php

declare(strict_types=1);

namespace DurableStreams\Internal;

use DurableStreams\Exception\DurableStreamException;
use DurableStreams\Exception\SeqConflictException;
use DurableStreams\Exception\StreamExistsException;
use DurableStreams\Exception\StreamNotFoundException;

/**
 * High-performance HTTP client using cURL.
 *
 * Uses persistent connections via cURL handle reuse for maximum throughput.
 */
final class HttpClient
{
    /** @var \CurlHandle|null Reusable cURL handle for connection pooling */
    private ?\CurlHandle $handle = null;

    private float $timeout;
    private float $connectTimeout;

    public function __construct(
        float $timeout = 30.0,
        float $connectTimeout = 10.0,
    ) {
        $this->timeout = $timeout;
        $this->connectTimeout = $connectTimeout;
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
     * Execute an HTTP request.
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
        $handle = $this->getHandle();

        // Build header array for cURL
        $curlHeaders = [];
        foreach ($headers as $name => $value) {
            $curlHeaders[] = "{$name}: {$value}";
        }

        // Set request-specific options
        curl_setopt_array($handle, [
            CURLOPT_URL => $url,
            CURLOPT_CUSTOMREQUEST => $method,
            CURLOPT_HTTPHEADER => $curlHeaders,
            CURLOPT_TIMEOUT_MS => (int)(($timeout ?? $this->timeout) * 1000),
        ]);

        // Handle body
        if ($body !== null) {
            curl_setopt($handle, CURLOPT_POSTFIELDS, $body);
        } else {
            curl_setopt($handle, CURLOPT_POSTFIELDS, '');
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

        // Handle error status codes
        $this->handleErrorStatus($statusCode, $url, $responseHeaders, $bodyStr);

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
     * Handle HTTP error status codes.
     *
     * @throws DurableStreamException
     */
    private function handleErrorStatus(
        int $status,
        string $url,
        array $headers,
        string $body,
    ): void {
        if ($status >= 200 && $status < 300) {
            return;
        }

        // 204 No Content is valid for some operations
        if ($status === 204) {
            return;
        }

        switch ($status) {
            case 404:
                throw new StreamNotFoundException($url);

            case 409:
                // Check if this is a sequence conflict (idempotent producer headers)
                $expectedSeq = isset($headers['producer-expected-seq'])
                    ? (int)$headers['producer-expected-seq']
                    : null;
                $receivedSeq = isset($headers['producer-received-seq'])
                    ? (int)$headers['producer-received-seq']
                    : null;

                if ($expectedSeq !== null || $receivedSeq !== null) {
                    throw new SeqConflictException(
                        "Sequence conflict: expected {$expectedSeq}, received {$receivedSeq}",
                        $expectedSeq,
                        $receivedSeq,
                        $headers
                    );
                }

                // Check if body indicates Stream-Seq conflict
                if (stripos($body, 'sequence conflict') !== false) {
                    throw new SeqConflictException(
                        $body ?: 'Sequence conflict',
                        null,
                        null,
                        $headers
                    );
                }

                // Otherwise it's a stream exists conflict
                throw new StreamExistsException($url);

            case 400:
                throw new DurableStreamException($body ?: 'Bad request', 'BAD_REQUEST', $status, $headers);

            case 401:
                throw new DurableStreamException('Unauthorized', 'UNAUTHORIZED', $status, $headers);

            case 403:
                throw new DurableStreamException($body ?: 'Forbidden', 'FORBIDDEN', $status, $headers);

            case 429:
                throw new DurableStreamException('Rate limited', 'RATE_LIMITED', $status, $headers);

            default:
                if ($status >= 500) {
                    throw new DurableStreamException(
                        "Server error: {$status}",
                        'SERVER_ERROR',
                        $status,
                        $headers
                    );
                }
                throw new DurableStreamException(
                    "Unexpected status: {$status}",
                    'UNEXPECTED_STATUS',
                    $status,
                    $headers
                );
        }
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
        $handle = $this->getHandle();

        $curlHeaders = [];
        foreach ($headers as $name => $value) {
            $curlHeaders[] = "{$name}: {$value}";
        }

        curl_setopt_array($handle, [
            CURLOPT_URL => $url,
            CURLOPT_CUSTOMREQUEST => 'HEAD',
            CURLOPT_HTTPHEADER => $curlHeaders,
            CURLOPT_NOBODY => true,
            CURLOPT_TIMEOUT_MS => (int)($this->timeout * 1000),
        ]);

        $response = curl_exec($handle);

        // Reset NOBODY for future requests
        curl_setopt($handle, CURLOPT_NOBODY, false);

        if ($response === false) {
            $error = curl_error($handle);
            throw new DurableStreamException("Network error: {$error}", 'NETWORK_ERROR');
        }

        $statusCode = (int)curl_getinfo($handle, CURLINFO_HTTP_CODE);
        $responseHeaders = $this->parseHeaders($response);

        $this->handleErrorStatus($statusCode, $url, $responseHeaders, '');

        return new HttpResponse($statusCode, $responseHeaders, '');
    }

    /**
     * Convenience method for DELETE requests.
     */
    public function delete(string $url, array $headers = []): HttpResponse
    {
        return $this->request('DELETE', $url, $headers);
    }
}
