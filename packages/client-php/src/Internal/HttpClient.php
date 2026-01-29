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
        // In PHP 8.0+, cURL handles are closed automatically when garbage collected
        // The curl_close() function is deprecated in PHP 8.5
        $this->handle = null;
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

    /**
     * Open a streaming GET connection (for SSE).
     *
     * Returns an SSEStreamHandle that wraps the curl_multi streaming.
     *
     * @param string $url Full URL
     * @param array<string, string> $headers Request headers
     * @param float|null $timeout Override default timeout
     * @return SSEStreamHandle The SSE stream handle
     * @throws DurableStreamException On connection errors
     */
    public function openStream(string $url, array $headers = [], ?float $timeout = null): SSEStreamHandle
    {
        return new SSEStreamHandle($url, $headers, $timeout ?? $this->timeout, $this->connectTimeout);
    }
}

/**
 * Handle for an SSE stream using curl_multi for non-blocking reads.
 */
final class SSEStreamHandle
{
    private \CurlHandle $handle;
    private \CurlMultiHandle $multi;
    private string $buffer = '';
    private bool $closed = false;
    private bool $finished = false;
    private float $timeout;
    private ?string $sseDataEncoding = null;

    /**
     * @param string $url Full URL
     * @param array<string, string> $headers Request headers
     * @param float $timeout Request timeout in seconds
     * @param float $connectTimeout Connection timeout in seconds
     * @throws DurableStreamException On connection errors
     */
    public function __construct(
        string $url,
        array $headers,
        float $timeout,
        float $connectTimeout,
    ) {
        $this->timeout = $timeout;

        // Create a new handle for streaming
        $handle = curl_init();
        if ($handle === false) {
            throw new DurableStreamException('Failed to initialize cURL', 'NETWORK_ERROR');
        }

        // Build header array for cURL
        $curlHeaders = [];
        foreach ($headers as $name => $value) {
            $curlHeaders[] = "{$name}: {$value}";
        }
        // Add Accept header for SSE
        $curlHeaders[] = 'Accept: text/event-stream';

        $responseHeaders = [];
        $headersDone = false;
        $statusCode = 0;
        $buffer = &$this->buffer;
        $sseDataEncoding = &$this->sseDataEncoding;

        curl_setopt_array($handle, [
            CURLOPT_URL => $url,
            CURLOPT_HTTPGET => true,
            CURLOPT_HTTPHEADER => $curlHeaders,
            CURLOPT_TIMEOUT_MS => (int)($timeout * 1000),
            CURLOPT_CONNECTTIMEOUT_MS => (int)($connectTimeout * 1000),
            CURLOPT_RETURNTRANSFER => false,
            CURLOPT_HEADER => false,
            CURLOPT_WRITEFUNCTION => function ($ch, $data) use (&$buffer) {
                $buffer .= $data;
                return strlen($data);
            },
            CURLOPT_HEADERFUNCTION => function ($ch, $header) use (&$responseHeaders, &$headersDone, &$statusCode, &$sseDataEncoding) {
                $len = strlen($header);
                if (trim($header) === '') {
                    $headersDone = true;
                    return $len;
                }
                // Parse status line
                if (preg_match('/^HTTP\/[\d.]+ (\d{3})/', $header, $m)) {
                    $statusCode = (int)$m[1];
                    return $len;
                }
                if (str_contains($header, ':')) {
                    [$name, $value] = explode(':', $header, 2);
                    $headerName = strtolower(trim($name));
                    $headerValue = trim($value);
                    $responseHeaders[$headerName] = $headerValue;
                    // Capture SSE data encoding header
                    if ($headerName === 'stream-sse-data-encoding') {
                        $sseDataEncoding = $headerValue;
                    }
                }
                return $len;
            },
            CURLOPT_HTTP_VERSION => CURL_HTTP_VERSION_1_1,
        ]);

        // Use curl_multi for non-blocking streaming
        $multi = curl_multi_init();
        curl_multi_add_handle($multi, $handle);

        // Start the transfer and wait for headers
        $running = null;
        $headersReceived = false;
        $startTime = microtime(true);

        do {
            $status = curl_multi_exec($multi, $running);

            // Check for connection timeout
            $elapsed = microtime(true) - $startTime;
            if (!$headersDone && $elapsed > $connectTimeout) {
                curl_multi_remove_handle($multi, $handle);
                curl_multi_close($multi);
                throw new DurableStreamException('Connection timeout', 'TIMEOUT');
            }

            // Process any messages (errors, completions)
            while ($info = curl_multi_info_read($multi)) {
                if ($info['msg'] === CURLMSG_DONE && $info['result'] !== CURLE_OK) {
                    $error = curl_error($handle);
                    $errno = $info['result'];
                    curl_multi_remove_handle($multi, $handle);
                    curl_multi_close($multi);

                    if ($errno === CURLE_OPERATION_TIMEDOUT) {
                        throw new DurableStreamException("Request timeout: {$error}", 'TIMEOUT');
                    }

                    throw new DurableStreamException("Network error: {$error}", 'NETWORK_ERROR');
                }
            }

            // Get the status code as soon as headers are done
            // @phpstan-ignore booleanNot.alwaysTrue (modified by HEADERFUNCTION callback)
            if ($headersDone && !$headersReceived) {
                $headersReceived = true;
                $statusCode = (int)curl_getinfo($handle, CURLINFO_HTTP_CODE);

                // Handle errors immediately after headers
                if ($statusCode === 404) {
                    curl_multi_remove_handle($multi, $handle);
                    curl_multi_close($multi);
                    throw new \DurableStreams\Exception\StreamNotFoundException("Stream not found: {$url}");
                }

                if ($statusCode === 400) {
                    curl_multi_remove_handle($multi, $handle);
                    curl_multi_close($multi);
                    throw new DurableStreamException('Bad request - encoding may be invalid or not supported', 'BAD_REQUEST');
                }

                if ($statusCode >= 400) {
                    curl_multi_remove_handle($multi, $handle);
                    curl_multi_close($multi);
                    throw new DurableStreamException("HTTP error {$statusCode}", 'UNEXPECTED_STATUS', $statusCode);
                }

                break; // Headers received successfully, continue with streaming
            }

            if ($status === CURLM_OK && $running) {
                // Wait a bit for activity
                curl_multi_select($multi, 0.01);
            }
        } while ($running && $status === CURLM_OK);

        // Check if transfer completed before headers (shouldn't happen for SSE)
        if (!$headersReceived && !$running) {
            $error = curl_error($handle);
            curl_multi_remove_handle($multi, $handle);
            curl_multi_close($multi);
            throw new DurableStreamException("Connection closed before headers: {$error}", 'NETWORK_ERROR');
        }

        $this->handle = $handle;
        $this->multi = $multi;
    }

    /**
     * Read data from the SSE stream.
     *
     * @param int $length Maximum number of bytes to read
     * @return string|false Data read, or false on EOF/error
     */
    public function read(int $length = 8192): string|false
    {
        if ($this->closed) {
            return false;
        }

        // If we have buffered data, return it
        if ($this->buffer !== '') {
            $data = substr($this->buffer, 0, $length);
            $this->buffer = substr($this->buffer, strlen($data));
            return $data;
        }

        // If transfer is finished, return EOF
        if ($this->finished) {
            return false;
        }

        // Poll for more data
        $startTime = microtime(true);
        // @phpstan-ignore booleanAnd.alwaysTrue, booleanNot.alwaysTrue (buffer modified by WRITEFUNCTION callback)
        while ($this->buffer === '' && !$this->finished) {
            $running = null;
            $status = curl_multi_exec($this->multi, $running);

            // Check for timeout
            $elapsed = microtime(true) - $startTime;
            if ($elapsed > $this->timeout) {
                $this->close();
                return false;
            }

            // Check for completion
            while ($info = curl_multi_info_read($this->multi)) {
                if ($info['msg'] === CURLMSG_DONE) {
                    $this->finished = true;
                    break 2;
                }
            }

            if (!$running) {
                $this->finished = true;
                break;
            }

            // @phpstan-ignore booleanAnd.rightAlwaysTrue (buffer modified by WRITEFUNCTION callback)
            if ($this->buffer === '' && $status === CURLM_OK && $running) {
                // Wait for activity
                curl_multi_select($this->multi, 0.01);
            }
        }

        // Return any buffered data
        // @phpstan-ignore notIdentical.alwaysFalse (buffer modified by WRITEFUNCTION callback)
        if ($this->buffer !== '') {
            $data = substr($this->buffer, 0, $length);
            $this->buffer = substr($this->buffer, strlen($data));
            return $data;
        }

        return false;
    }

    /**
     * Check if the stream has reached EOF.
     */
    public function eof(): bool
    {
        return $this->finished && $this->buffer === '';
    }

    /**
     * Get the SSE data encoding from response header.
     *
     * @return string|null The encoding (e.g., 'base64') or null if not set
     */
    public function getSseDataEncoding(): ?string
    {
        return $this->sseDataEncoding;
    }

    /**
     * Close the stream.
     */
    public function close(): void
    {
        if ($this->closed) {
            return;
        }

        $this->closed = true;
        @curl_multi_remove_handle($this->multi, $this->handle);
        @curl_multi_close($this->multi);
    }

    public function __destruct()
    {
        $this->close();
    }
}
