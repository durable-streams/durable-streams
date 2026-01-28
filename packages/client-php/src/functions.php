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
 *   encoding?: string,
 *   headers?: array<string, string|callable>,
 *   timeout?: float,
 *   retry?: RetryOptions,
 *   client?: HttpClientInterface,
 *   onError?: callable(DurableStreamException): ?array,
 * } $options
 * @throws DurableStreamException If encoding is provided without live=sse
 */
function stream(array $options): StreamResponse
{
    $url = $options['url'];
    $offset = $options['offset'] ?? '-1';
    $live = $options['live'] ?? LiveMode::Off;
    $encoding = $options['encoding'] ?? null;
    $headers = $options['headers'] ?? [];
    $timeout = $options['timeout'] ?? 30.0;
    $retry = $options['retry'] ?? null;
    $onError = $options['onError'] ?? null;
    $client = $options['client'] ?? new HttpClient(
        timeout: $timeout,
        retryOptions: $retry,
    );

    // Validate encoding is only used with live=sse (Protocol Section 5.7)
    if ($encoding !== null && $live !== LiveMode::SSE) {
        throw new DurableStreamException(
            'encoding parameter is only valid with live=sse',
            'BAD_REQUEST'
        );
    }

    return new StreamResponse(
        url: $url,
        initialOffset: $offset,
        liveMode: $live,
        encoding: $encoding,
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
