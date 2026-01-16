<?php

declare(strict_types=1);

namespace DurableStreams;

use DurableStreams\Exception\DurableStreamException;
use DurableStreams\Internal\HttpClient;
use DurableStreams\Internal\HttpClientInterface;

/**
 * Create a stream response for reading from a Durable Stream.
 *
 * @param array{
 *   url: string,
 *   offset?: string,
 *   live?: LiveMode,
 *   headers?: array<string, string|callable>,
 *   timeout?: float,
 *   retry?: RetryOptions,
 *   client?: HttpClientInterface,
 *   onError?: callable(DurableStreamException): ?array,
 * } $options
 */
function stream(array $options): StreamResponse
{
    $url = $options['url'];
    $offset = $options['offset'] ?? '-1';
    $live = $options['live'] ?? LiveMode::Off;
    $headers = $options['headers'] ?? [];
    $timeout = $options['timeout'] ?? 30.0;
    $retry = $options['retry'] ?? null;
    $onError = $options['onError'] ?? null;
    $client = $options['client'] ?? new HttpClient(
        timeout: $timeout,
        retryOptions: $retry,
    );

    return new StreamResponse(
        url: $url,
        initialOffset: $offset,
        liveMode: $live,
        headers: $headers,
        client: $client,
        timeout: $timeout,
        onError: $onError,
    );
}

/**
 * Get the client version.
 */
function version(): string
{
    return '0.1.0';
}
