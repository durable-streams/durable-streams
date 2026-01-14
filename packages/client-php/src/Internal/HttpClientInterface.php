<?php

declare(strict_types=1);

namespace DurableStreams\Internal;

/**
 * Interface for HTTP clients used by Durable Streams.
 *
 * This allows using either the built-in cURL client or a PSR-18 adapter.
 */
interface HttpClientInterface
{
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
    ): HttpResponse;

    /**
     * Convenience method for GET requests.
     */
    public function get(string $url, array $headers = [], ?float $timeout = null): HttpResponse;

    /**
     * Convenience method for POST requests.
     */
    public function post(string $url, string $body, array $headers = []): HttpResponse;

    /**
     * Convenience method for PUT requests.
     */
    public function put(string $url, array $headers = [], ?string $body = null): HttpResponse;

    /**
     * Convenience method for HEAD requests.
     */
    public function head(string $url, array $headers = []): HttpResponse;

    /**
     * Convenience method for DELETE requests.
     */
    public function delete(string $url, array $headers = []): HttpResponse;
}
