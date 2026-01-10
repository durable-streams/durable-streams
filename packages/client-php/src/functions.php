<?php

declare(strict_types=1);

namespace DurableStreams;

use DurableStreams\Internal\HttpClient;

/**
 * Create a stream response for reading from a Durable Stream.
 *
 * @param array{
 *   url: string,
 *   offset?: string,
 *   live?: string|false,
 *   headers?: array<string, string>,
 *   timeout?: float,
 *   client?: HttpClient,
 * } $options
 */
function stream(array $options): StreamResponse
{
    $url = $options['url'];
    $offset = $options['offset'] ?? '-1';
    $live = $options['live'] ?? false;
    $headers = $options['headers'] ?? [];
    $timeout = $options['timeout'] ?? 30.0;
    $client = $options['client'] ?? new HttpClient(timeout: $timeout);

    return new StreamResponse(
        url: $url,
        initialOffset: $offset,
        liveMode: $live,
        headers: $headers,
        client: $client,
        timeout: $timeout,
    );
}

/**
 * Get the client version.
 */
function version(): string
{
    return '0.1.0';
}
