# PHP Client Design for Durable Streams

## Executive Summary

This document proposes a PHP client design for the Durable Streams protocol, based on research of PHP SDKs for Kafka, Redis Streams, NATS JetStream, Apache Pulsar, AWS Kinesis, Google Cloud Pub/Sub, Azure Event Hubs, and RabbitMQ Streams.

**Key Design Principles:**

1. **Synchronous I/O** - All network I/O blocks; no background threads or async runtime required
2. **PSR-compliant** - PSR-18 HTTP Client, PSR-7 Messages, PSR-3 Logging
3. **Fluent builders** - Chainable configuration (Kafka, NATS, Pulsar patterns)
4. **Generator-based iteration** - Memory-efficient streaming (universal PHP pattern)
5. **Local batching with explicit flush** - `enqueue()` queues locally, `flush()` does I/O

---

## Table of Contents

1. [Research Summary](#research-summary)
2. [Architecture Overview](#architecture-overview)
3. [Core Classes](#core-classes)
4. [API Design](#api-design)
5. [Configuration](#configuration)
6. [Error Handling](#error-handling)
7. [SSE and Long-Poll Support](#sse-and-long-poll-support)
8. [Idempotent Producer](#idempotent-producer)
9. [PHP-Specific Considerations](#php-specific-considerations)
10. [Example Usage](#example-usage)
11. [Package Structure](#package-structure)

---

## Research Summary

### Patterns Observed Across PHP Streaming SDKs

| Pattern                         | Used By                             | Recommendation               |
| ------------------------------- | ----------------------------------- | ---------------------------- |
| **Fluent Builder**              | Kafka (php-kafka-lib), NATS, Pulsar | ✅ Adopt for Options classes |
| **Immutable Message Objects**   | Kafka, RabbitMQ                     | ✅ Adopt for `Payload` class |
| **Generator/Yield Iteration**   | All (universal PHP pattern)         | ✅ Primary consumption API   |
| **Blocking Poll with Timeout**  | Kafka, Redis, NATS                  | ✅ For long-poll mode        |
| **Callback-based Subscription** | RabbitMQ, NATS                      | ⚠️ Optional, secondary API   |
| **Explicit flush()**            | Kafka (critical), Pulsar            | ✅ Required for producers    |
| **PSR-18 HTTP Client**          | AWS SDK, Guzzle-based SDKs          | ✅ For HTTP transport        |
| **Exception Hierarchy**         | All mature SDKs                     | ✅ Structured error types    |

### PHP HTTP Streaming Capabilities

| Method             | PHP Support  | Notes                                                      |
| ------------------ | ------------ | ---------------------------------------------------------- |
| **Long-Poll**      | ✅ Excellent | Native blocking request; best fit for PHP                  |
| **SSE**            | ⚠️ Limited   | Requires streaming response body; Symfony HttpClient works |
| **HTTP/2 Streams** | ❌ Poor      | Most PHP HTTP clients don't expose HTTP/2 multiplexing     |

**Recommendation:** Default to long-poll; SSE as opt-in for long-running CLI consumers.

### PSR-18 Limitations

PSR-18 is intentionally minimal and does not standardize:

- Streaming response bodies (buffering is implementation-dependent)
- Request cancellation mid-flight
- Fine-grained timeout control (connect vs read vs total)
- SSE event framing

**Implications for this client:**

- **Cancellation is "soft"**: `StreamResponse::cancel()` prevents the _next_ HTTP request,
  but cannot abort an in-flight request. The current poll completes before cancellation.
- **SSE requires a streaming-capable client**: Symfony HttpClient or a custom cURL wrapper.
  Not all PSR-18 implementations will work for SSE.
- **Long-poll is the safest default**: Works with any PSR-18 implementation.

Future versions may introduce a `StreamingTransport` interface for clients that need
true SSE support with hard cancellation.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        User Application                         │
└─────────────────────────────────────────────────────────────────┘
                               │
           ┌───────────────────┼───────────────────┐
           ▼                   ▼                   ▼
┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐
│  DurableStream  │  │ IdempotentProd- │  │  stream()       │
│  (Read/Write)   │  │     ucer        │  │  (Read-only)    │
└─────────────────┘  └─────────────────┘  └─────────────────┘
           │                   │                   │
           └───────────────────┼───────────────────┘
                               ▼
                    ┌─────────────────────┐
                    │   HttpTransport     │
                    │   (PSR-18 Client)   │
                    └─────────────────────┘
                               │
           ┌───────────────────┼───────────────────┐
           ▼                   ▼                   ▼
    ┌────────────┐     ┌────────────┐     ┌────────────┐
    │ Long-Poll  │     │    SSE     │     │  Chunked   │
    │  Handler   │     │   Parser   │     │  Append    │
    └────────────┘     └────────────┘     └────────────┘
```

---

## Core Classes

### Class Diagram

```
DurableStreamClient (factory)
    └── create(): DurableStream
    └── connect(): DurableStream

DurableStream (handle)
    ├── head(): HeadResult
    ├── append(mixed $data): AppendResult  (synchronous HTTP request)
    ├── appendStream(iterable $source): void
    ├── stream(?StreamOptions $options): StreamResponse
    ├── delete(): void
    └── close(): void

IdempotentProducer
    ├── enqueue(mixed $data): void  (queues locally, no I/O)
    ├── flush(): void               (sends batches, blocks until complete)
    ├── restart(): void
    └── close(): void

StreamResponse (read session)
    ├── getIterator(): Generator<JsonBatch>
    ├── jsonStream(): Generator<mixed>
    ├── bodyStream(): Generator<string>
    ├── json(): array               (throws on live streams)
    ├── body(): string              (throws on live streams)
    ├── cancel(): void              (soft-cancel with PSR-18)
    ├── getOffset(): string
    └── isLive(): bool

Options Classes (builders)
    ├── ClientOptions
    ├── StreamOptions
    ├── ProducerOptions
    └── AppendOptions
```

---

## API Design

### 1. Client Factory

Following AWS SDK and Google Cloud patterns:

```php
<?php

namespace DurableStreams;

use Psr\Http\Client\ClientInterface;
use Psr\Log\LoggerInterface;

final class DurableStreamClient
{
    public function __construct(
        private ClientOptions $options,
        private ?ClientInterface $httpClient = null,
        private ?LoggerInterface $logger = null,
    ) {}

    /**
     * Create a new stream (PUT request)
     * @throws StreamAlreadyExistsException
     */
    public function create(string $url, ?CreateOptions $options = null): DurableStream;

    /**
     * Connect to existing stream (validates via HEAD)
     * @throws StreamNotFoundException
     */
    public function connect(string $url): DurableStream;
}
```

### 2. DurableStream Handle

The main class for interacting with a stream:

```php
<?php

namespace DurableStreams;

final class DurableStream
{
    /**
     * Get stream metadata (HEAD request)
     */
    public function head(): HeadResult;

    /**
     * Append data to stream (POST request - blocks until complete)
     * For JSON streams, arrays are flattened per protocol spec
     */
    public function append(mixed $data, ?AppendOptions $options = null): AppendResult;

    /**
     * Stream append from iterable source using chunked transfer encoding.
     *
     * Each item from the source is sent immediately as it's yielded - this
     * is NOT batched like IdempotentProducer. Use this for large data where
     * you don't want to buffer everything in memory before sending.
     *
     * For batching semantics, use IdempotentProducer instead.
     *
     * @param iterable<string|array> $source Items to append (arrays are JSON-encoded)
     */
    public function appendStream(iterable $source): void;

    /**
     * Start a read session
     */
    public function stream(?StreamOptions $options = null): StreamResponse;

    /**
     * Delete the stream
     */
    public function delete(): void;

    /**
     * Close and release resources
     */
    public function close(): void;

    /**
     * Get stream URL
     */
    public function getUrl(): string;

    /**
     * Get content type
     */
    public function getContentType(): string;
}
```

### 3. StreamResponse (Read Session)

Generator-based iteration following universal PHP streaming patterns:

```php
<?php

namespace DurableStreams;

/**
 * @implements \IteratorAggregate<JsonBatch>
 */
final class StreamResponse implements \IteratorAggregate
{
    /**
     * Iterate over JSON batches (primary API)
     * @return \Generator<JsonBatch>
     */
    public function getIterator(): \Generator;

    /**
     * Iterate over individual JSON items
     * @return \Generator<mixed>
     */
    public function jsonStream(): \Generator;

    /**
     * Iterate over raw body chunks
     * @return \Generator<string>
     */
    public function bodyStream(): \Generator;

    /**
     * Collect all JSON items into an array.
     * Only valid for catch-up mode (live: false).
     *
     * @return array<mixed>
     * @throws \LogicException if called on a live stream (would block forever)
     */
    public function json(): array;

    /**
     * Collect full body as string.
     * Only valid for catch-up mode (live: false).
     *
     * @throws \LogicException if called on a live stream (would block forever)
     */
    public function body(): string;

    /**
     * Cancel the read session.
     *
     * Note: With PSR-18, this is a "soft cancel" - it prevents the next
     * request but cannot abort an in-flight HTTP request. The current
     * poll will complete before cancellation takes effect.
     */
    public function cancel(): void;

    /**
     * Get current offset
     */
    public function getOffset(): string;

    /**
     * Check if stream is up-to-date
     */
    public function isUpToDate(): bool;

    /**
     * Check if this is a live (infinite) stream
     */
    public function isLive(): bool;
}
```

### 4. Read-Only Function

Standalone function for consumers who don't write (following TypeScript client):

```php
<?php

namespace DurableStreams;

/**
 * Standalone read-only stream function
 *
 * @param array{
 *   url: string,
 *   headers?: array<string, string|callable>,
 *   offset?: string,
 *   live?: bool|'long-poll'|'sse',
 *   onError?: callable(DurableStreamException): ?array,
 * } $options
 */
function stream(array $options): StreamResponse;
```

### 5. IdempotentProducer

Batching producer with exactly-once semantics. Uses local queuing for efficiency.

**Key insight:** PHP has no background threads, so `enqueue()` cannot do async I/O.
Instead, `enqueue()` queues data locally (instant return, no network), and `flush()`
performs all HTTP requests synchronously (blocks until complete).

**Why `enqueue()` not `append()`?** The `DurableStream::append()` method is synchronous
(immediate HTTP request). Using the same name for the batching version would be confusing.
`enqueue()` makes the "queue now, send later" semantics explicit.

```php
<?php

namespace DurableStreams;

final class IdempotentProducer
{
    public function __construct(
        DurableStream $stream,
        string $producerId,
        ?ProducerOptions $options = null,
    );

    /**
     * Queue data locally for batched sending.
     * Returns immediately - no network I/O performed.
     * Auto-flushes if batch size limit reached.
     *
     * @throws MessageTooLargeException if single item exceeds maxBatchBytes
     */
    public function enqueue(mixed $data): void;

    /**
     * Send all queued batches to server.
     * Blocks until all HTTP requests complete.
     * @throws ProducerException on network or protocol errors
     */
    public function flush(): void;

    /**
     * Increment epoch and reset sequence (zombie fencing)
     */
    public function restart(): void;

    /**
     * Get current epoch
     */
    public function getEpoch(): int;

    /**
     * Get current sequence number
     */
    public function getSeq(): int;

    /**
     * Flush and close
     */
    public function close(): void;
}
```

---

## Configuration

### ClientOptions (Builder Pattern)

Following Kafka/NATS fluent builder patterns:

```php
<?php

namespace DurableStreams;

final class ClientOptions
{
    private function __construct() {}

    public static function create(): self;

    // Connection settings
    public function withTimeout(float $seconds): self;
    public function withConnectTimeout(float $seconds): self;

    // Retry configuration
    public function withRetry(RetryOptions $retry): self;
    public function withMaxRetries(int $max): self;
    public function withInitialDelay(float $ms): self;
    public function withMaxDelay(float $ms): self;
    public function withMultiplier(float $factor): self;

    // Headers (static or dynamic)
    public function withHeaders(array $headers): self;
    public function withHeader(string $name, string|callable $value): self;

    // HTTP client customization
    public function withHttpClient(ClientInterface $client): self;

    // Build immutable options
    public function build(): self;
}
```

### StreamOptions

```php
<?php

namespace DurableStreams;

final class StreamOptions
{
    public static function create(): self;

    public function withOffset(string $offset): self;
    public function withLive(bool|string $mode): self;  // false, 'long-poll', 'sse'
    public function withHeaders(array $headers): self;
    public function withParams(array $params): self;

    /**
     * Error handler for recoverable errors
     * Return array to retry with new options, null to stop
     * @param callable(DurableStreamException): ?array $handler
     */
    public function withOnError(callable $handler): self;
}
```

### ProducerOptions

```php
<?php

namespace DurableStreams;

final class ProducerOptions
{
    public static function create(): self;

    public function withEpoch(int $epoch): self;
    public function withAutoClaim(bool $enabled): self;
    public function withMaxBatchBytes(int $bytes): self;
    public function withMaxBatchItems(int $count): self;
}
```

**Note:** Unlike async clients, there's no `lingerMs` or `maxInFlight` options.
PHP's synchronous model means batches are sent immediately on `flush()`, not
scheduled for background delivery.

### CreateOptions

```php
<?php

namespace DurableStreams;

final class CreateOptions
{
    public static function create(): self;

    public function withContentType(string $contentType): self;
    public function withHeaders(array $headers): self;
}
```

---

## Error Handling

### Exception Hierarchy

Following mature SDK patterns (Kafka, Google Cloud):

```
DurableStreamException (base)
├── TransportException
│   ├── ConnectionException
│   ├── TimeoutException
│   └── NetworkException
├── ProtocolException
│   ├── StreamNotFoundException        (404)
│   ├── StreamAlreadyExistsException   (409 on create)
│   ├── SequenceConflictException      (409 on append)
│   ├── BadRequestException            (400)
│   ├── UnauthorizedException          (401)
│   ├── ForbiddenException             (403)
│   ├── RateLimitedException           (429)
│   └── ServiceUnavailableException    (503)
└── ProducerException
    ├── StaleEpochException
    ├── SequenceGapException
    └── MessageTooLargeException
```

### Exception Interface

```php
<?php

namespace DurableStreams\Exception;

interface DurableStreamExceptionInterface extends \Throwable
{
    public function getErrorCode(): string;
    public function isRetryable(): bool;
}

class ProtocolException extends DurableStreamException
{
    public function __construct(
        string $message,
        private string $errorCode,
        private int $httpStatus,
        private array $headers = [],
        ?\Throwable $previous = null,
    );

    public function getErrorCode(): string;
    public function getHttpStatus(): int;
    public function getHeaders(): array;

    public function isRetryable(): bool
    {
        return in_array($this->httpStatus, [429, 503]);
    }
}

class StaleEpochException extends ProducerException
{
    public function __construct(
        private int $currentEpoch,
        ?\Throwable $previous = null,
    );

    public function getCurrentEpoch(): int;
}
```

### Error Codes

```php
<?php

namespace DurableStreams;

enum ErrorCode: string
{
    case NOT_FOUND = 'NOT_FOUND';
    case CONFLICT_SEQ = 'CONFLICT_SEQ';
    case CONFLICT_EXISTS = 'CONFLICT_EXISTS';
    case BAD_REQUEST = 'BAD_REQUEST';
    case UNAUTHORIZED = 'UNAUTHORIZED';
    case FORBIDDEN = 'FORBIDDEN';
    case RATE_LIMITED = 'RATE_LIMITED';
    case BUSY = 'BUSY';
    case SSE_NOT_SUPPORTED = 'SSE_NOT_SUPPORTED';
    case ALREADY_CLOSED = 'ALREADY_CLOSED';
    case UNKNOWN = 'UNKNOWN';
}
```

---

## SSE and Long-Poll Support

### Long-Poll Implementation (Default)

**Important:** Termination behavior depends on `live` mode:

- `live: false` (catch-up): Stop when `upToDate` is true
- `live: 'long-poll'`: Keep polling forever (until cancelled or error)
- `live: 'sse'`: Keep reading until disconnect

```php
<?php

namespace DurableStreams\Internal;

final class LongPollHandler
{
    public function __construct(
        private HttpTransport $transport,
        private RetryOptions $retry,
    ) {}

    /**
     * @param bool $live If true, keep polling even after catching up
     * @return \Generator<ResponseChunk>
     */
    public function consume(string $url, string $offset, ?string $cursor, bool $live): \Generator
    {
        while (true) {
            $response = $this->transport->get($url, [
                'query' => [
                    'offset' => $offset,
                    'live' => $live ? 'long-poll' : null,
                    'cursor' => $cursor,
                ],
            ]);

            if ($response->getStatusCode() === 204) {
                // Timeout, no new data - but update cursor
                $cursor = $response->getHeaderLine('Stream-Cursor');
                yield new ResponseChunk(
                    data: '',
                    offset: $offset,
                    cursor: $cursor,
                    upToDate: true,
                );
                continue; // Keep polling (live mode only reaches here)
            }

            $newOffset = $response->getHeaderLine('Stream-Next-Offset');
            $newCursor = $response->getHeaderLine('Stream-Cursor');
            $upToDate = $response->getHeaderLine('Stream-Up-To-Date') === 'true';

            yield new ResponseChunk(
                data: (string) $response->getBody(),
                offset: $newOffset,
                cursor: $newCursor,
                upToDate: $upToDate,
            );

            $offset = $newOffset;
            $cursor = $newCursor;

            // Only stop if catch-up mode (not live) and we're caught up
            if ($upToDate && !$live) {
                return;
            }
        }
    }
}
```

### SSE Implementation (Opt-in)

```php
<?php

namespace DurableStreams\Internal;

final class SseHandler
{
    /**
     * @return \Generator<SseEvent>
     */
    public function consume(string $url, string $offset): \Generator
    {
        $response = $this->transport->stream($url, [
            'query' => ['offset' => $offset, 'live' => 'sse'],
            'headers' => ['Accept' => 'text/event-stream'],
        ]);

        $buffer = '';
        foreach ($response->getBody() as $chunk) {
            $buffer .= $chunk;

            // Parse SSE events (split on double newline)
            while (($pos = strpos($buffer, "\n\n")) !== false) {
                $eventData = substr($buffer, 0, $pos);
                $buffer = substr($buffer, $pos + 2);

                yield $this->parseEvent($eventData);
            }
        }
    }

    private function parseEvent(string $raw): SseEvent
    {
        $type = 'message';
        $data = [];

        foreach (explode("\n", $raw) as $line) {
            if (str_starts_with($line, 'event:')) {
                $type = trim(substr($line, 6));
            } elseif (str_starts_with($line, 'data:')) {
                $data[] = substr($line, 5);
            }
        }

        return new SseEvent($type, implode("\n", $data));
    }
}
```

---

## Idempotent Producer

### Implementation Design

The producer uses **local batching with synchronous flush**:

- `append()` adds items to an in-memory queue (no I/O)
- When batch size limit is reached, or `flush()` is called, HTTP requests are made
- All I/O in `flush()` is blocking/synchronous

```php
<?php

namespace DurableStreams;

final class IdempotentProducer
{
    private int $epoch;
    private int $nextSeq = 0;
    private array $pendingBatches = [];  // Batches ready to send
    private array $currentBatch = [];     // Items accumulating
    private int $currentBatchSize = 0;

    public function __construct(
        private DurableStream $stream,
        private string $producerId,
        private ProducerOptions $options,
    ) {
        $this->epoch = $options->getEpoch();
    }

    public function enqueue(mixed $data): void
    {
        $encoded = json_encode($data);
        $size = strlen($encoded);

        // Reject single items that exceed max batch size
        if ($size > $this->options->getMaxBatchBytes()) {
            throw new MessageTooLargeException(
                "Item size ({$size} bytes) exceeds maxBatchBytes ({$this->options->getMaxBatchBytes()})"
            );
        }

        // Auto-flush if batch would exceed max size
        if ($this->currentBatchSize + $size > $this->options->getMaxBatchBytes()) {
            $this->flush(); // Synchronous - blocks until sent
        }

        $this->currentBatch[] = $data;
        $this->currentBatchSize += $size;
    }

    /**
     * Send all queued data. Blocks until complete.
     */
    public function flush(): void
    {
        $this->flushCurrentBatch();
        $this->sendAllBatches(); // Synchronous HTTP requests
    }

    private function flushCurrentBatch(): void
    {
        if (empty($this->currentBatch)) {
            return;
        }

        $this->pendingBatches[] = new PendingBatch(
            data: $this->currentBatch,
            seq: $this->nextSeq++,
            epoch: $this->epoch,
        );

        $this->currentBatch = [];
        $this->currentBatchSize = 0;
    }

    /**
     * Send all pending batches synchronously.
     * Each HTTP request blocks until complete.
     */
    private function sendAllBatches(): void
    {
        foreach ($this->pendingBatches as $key => $batch) {
            $this->sendBatch($batch);
            unset($this->pendingBatches[$key]);
        }
    }

    private function sendBatch(PendingBatch $batch): void
    {
        $maxAttempts = 3;

        for ($attempt = 1; $attempt <= $maxAttempts; $attempt++) {
            try {
                // Synchronous HTTP request - blocks here
                $this->stream->appendWithHeaders(
                    $batch->getData(),
                    [
                        'Producer-Id' => $this->producerId,
                        'Producer-Epoch' => (string) $batch->getEpoch(),
                        'Producer-Seq' => (string) $batch->getSeq(),
                    ]
                );
                return; // Success

            } catch (ForbiddenException $e) {
                // Stale epoch - handle auto-claim or throw
                $currentEpoch = (int) ($e->getHeaders()['Producer-Epoch'] ?? 0);

                if ($this->options->isAutoClaim()) {
                    $this->epoch = $currentEpoch + 1;
                    $batch->updateEpoch($this->epoch);
                    $batch->updateSeq(0);
                    $this->nextSeq = 1;
                    // Loop will retry with new epoch
                } else {
                    throw new StaleEpochException($currentEpoch, $e);
                }

            } catch (SequenceConflictException $e) {
                // Duplicate detection - batch already delivered, safe to continue
                // (This can happen if previous request succeeded but response was lost)
                return;
            }
        }

        throw new ProducerException("Failed to send batch after {$maxAttempts} attempts");
    }

    public function restart(): void
    {
        $this->flush();
        $this->epoch++;
        $this->nextSeq = 0;
    }

    public function close(): void
    {
        $this->flush();
    }
}
```

---

## PHP-Specific Considerations

### 1. Script Lifecycle Safety

PHP scripts can terminate unexpectedly. Following Kafka's `flush()` pattern:

```php
// CRITICAL: Always flush before script ends
$producer = new IdempotentProducer($stream, 'worker-1', $options);

try {
    foreach ($events as $event) {
        $producer->append($event);
    }
} finally {
    $producer->close(); // Ensures flush on success or exception
}

// Or use destructor pattern
class SafeProducer
{
    public function __destruct()
    {
        try {
            $this->producer->close();
        } catch (\Throwable $e) {
            // Log but don't throw from destructor
            error_log("Failed to flush producer: " . $e->getMessage());
        }
    }
}
```

### 2. Long-Running CLI Consumers

```php
#!/usr/bin/env php
<?php

// Signal handling for graceful shutdown
$running = true;
pcntl_signal(SIGTERM, function () use (&$running) {
    $running = false;
});
pcntl_signal(SIGINT, function () use (&$running) {
    $running = false;
});

$client = new DurableStreamClient(ClientOptions::create()->build());
$stream = $client->connect('https://api.example.com/streams/events');

$response = $stream->stream(
    StreamOptions::create()
        ->withOffset($lastOffset)
        ->withLive('long-poll')
        ->build()
);

foreach ($response as $batch) {
    pcntl_signal_dispatch(); // Check signals between batches

    if (!$running) {
        break;
    }

    foreach ($batch->getItems() as $item) {
        processEvent($item);
    }

    saveOffset($batch->getOffset()); // Checkpoint
}

echo "Graceful shutdown complete\n";
```

### 3. Memory-Efficient Streaming

Using generators throughout:

```php
// Memory-efficient - processes one batch at a time
foreach ($stream->stream() as $batch) {
    foreach ($batch->getItems() as $item) {
        yield $item; // Further streaming to caller
    }
}

// vs. Memory-intensive (avoid for large streams)
$allItems = $stream->stream()->json(); // Loads everything into memory
```

### 4. HTTP Client Compatibility

PSR-18 compliance ensures compatibility with popular clients:

```php
// Guzzle
$httpClient = new \GuzzleHttp\Client(['timeout' => 30]);
$client = new DurableStreamClient($options, $httpClient);

// Symfony HttpClient (with PSR-18 adapter)
$httpClient = (new \Symfony\Component\HttpClient\Psr18Client());
$client = new DurableStreamClient($options, $httpClient);

// Default (bundled client)
$client = new DurableStreamClient($options); // Uses built-in cURL wrapper
```

### 5. Async Support (Optional)

For high-throughput scenarios, optional Swoole/Fibers support:

```php
// With Swoole coroutines
\Swoole\Runtime::enableCoroutine(SWOOLE_HOOK_ALL);

go(function () {
    $stream = $client->connect($url);
    foreach ($stream->stream() as $batch) {
        // Non-blocking I/O via Swoole hooks
    }
});

// With PHP 8.1+ Fibers (future consideration)
// Framework integration (ReactPHP, Amp) via adapters
```

---

## Example Usage

### Basic Producer

```php
<?php

use DurableStreams\DurableStreamClient;
use DurableStreams\ClientOptions;
use DurableStreams\CreateOptions;

$client = new DurableStreamClient(
    ClientOptions::create()
        ->withTimeout(30)
        ->withHeader('Authorization', 'Bearer ' . $token)
        ->build()
);

// Create a JSON stream
$stream = $client->create(
    'https://api.example.com/streams/events',
    CreateOptions::create()
        ->withContentType('application/json')
        ->build()
);

// Simple append - each call makes an HTTP request (blocking)
$result = $stream->append(['type' => 'user.created', 'userId' => 123]);
echo "Appended at offset: " . $result->getOffset();
```

### Basic Consumer

```php
<?php

use DurableStreams\DurableStreamClient;
use DurableStreams\StreamOptions;

$client = new DurableStreamClient($options);
$stream = $client->connect('https://api.example.com/streams/events');

// Catch-up from last known offset
$response = $stream->stream(
    StreamOptions::create()
        ->withOffset($lastOffset ?? '-1')
        ->build()
);

foreach ($response as $batch) {
    foreach ($batch->getItems() as $event) {
        processEvent($event);
    }
    saveCheckpoint($batch->getOffset());
}
```

### Live Consumer (Long-Poll)

```php
<?php

$response = $stream->stream(
    StreamOptions::create()
        ->withOffset('now')  // Start from current position
        ->withLive('long-poll')
        ->withOnError(function ($error) use (&$token) {
            if ($error->getErrorCode() === 'UNAUTHORIZED') {
                $token = refreshToken();
                return ['headers' => ['Authorization' => 'Bearer ' . $token]];
            }
            return null; // Stop on other errors
        })
        ->build()
);

// Infinite loop - processes events as they arrive
foreach ($response as $batch) {
    foreach ($batch->getItems() as $event) {
        handleEvent($event);
    }
}
```

### Idempotent Producer

```php
<?php

use DurableStreams\IdempotentProducer;
use DurableStreams\ProducerOptions;

$producer = new IdempotentProducer(
    $stream,
    'order-processor',
    ProducerOptions::create()
        ->withEpoch(0)
        ->withAutoClaim(true)
        ->withMaxBatchBytes(64 * 1024)  // 64KB batches
        ->build()
);

// Queue locally - no network I/O yet
foreach ($orders as $order) {
    $producer->enqueue(['type' => 'order.created', 'order' => $order]);
    // Note: may auto-flush if batch size limit reached
}

// Send all remaining queued data (blocks until complete)
$producer->close();
```

### Read-Only Function API

```php
<?php

use function DurableStreams\stream;

$response = stream([
    'url' => 'https://api.example.com/streams/events',
    'offset' => '-1',
    'live' => 'long-poll',
    'headers' => [
        'Authorization' => fn() => 'Bearer ' . getCurrentToken(),
    ],
    'onError' => function ($error) {
        if ($error->isRetryable()) {
            return []; // Retry with same options
        }
        return null; // Stop
    },
]);

foreach ($response->jsonStream() as $item) {
    echo json_encode($item) . "\n";
}
```

---

## Package Structure

```
durable-streams-php/
├── composer.json
├── src/
│   ├── DurableStreamClient.php
│   ├── DurableStream.php
│   ├── IdempotentProducer.php
│   ├── StreamResponse.php
│   ├── functions.php                 # stream() function
│   │
│   ├── Options/
│   │   ├── ClientOptions.php
│   │   ├── StreamOptions.php
│   │   ├── ProducerOptions.php
│   │   ├── CreateOptions.php
│   │   ├── AppendOptions.php
│   │   └── RetryOptions.php
│   │
│   ├── Result/
│   │   ├── HeadResult.php
│   │   ├── AppendResult.php
│   │   └── JsonBatch.php
│   │
│   ├── Exception/
│   │   ├── DurableStreamException.php
│   │   ├── TransportException.php
│   │   ├── ProtocolException.php
│   │   ├── ProducerException.php
│   │   ├── StreamNotFoundException.php
│   │   ├── SequenceConflictException.php
│   │   ├── StaleEpochException.php
│   │   └── ...
│   │
│   ├── Internal/
│   │   ├── HttpTransport.php
│   │   ├── LongPollHandler.php
│   │   ├── SseHandler.php
│   │   ├── SseParser.php
│   │   ├── BatchQueue.php
│   │   └── RetryPolicy.php
│   │
│   └── Enum/
│       ├── ErrorCode.php
│       └── LiveMode.php
│
├── tests/
│   ├── Unit/
│   │   ├── SseParserTest.php
│   │   ├── BatchQueueTest.php
│   │   └── ...
│   └── Integration/
│       └── ConformanceTest.php       # Runs against conformance suite
│
└── examples/
    ├── producer.php
    ├── consumer.php
    ├── idempotent-producer.php
    └── cli-worker.php
```

### composer.json

```json
{
  "name": "durable-streams/client",
  "description": "PHP client for Durable Streams protocol",
  "type": "library",
  "license": "MIT",
  "require": {
    "php": ">=8.1",
    "psr/http-client": "^1.0",
    "psr/http-factory": "^1.0",
    "psr/http-message": "^1.0|^2.0",
    "psr/log": "^2.0|^3.0"
  },
  "require-dev": {
    "phpunit/phpunit": "^10.0",
    "guzzlehttp/guzzle": "^7.0",
    "symfony/http-client": "^6.0|^7.0"
  },
  "suggest": {
    "guzzlehttp/guzzle": "HTTP client implementation",
    "symfony/http-client": "Alternative HTTP client with streaming support",
    "ext-swoole": "For async/coroutine support"
  },
  "autoload": {
    "psr-4": {
      "DurableStreams\\": "src/"
    },
    "files": ["src/functions.php"]
  }
}
```

---

## Comparison with Other Clients

| Feature             | TypeScript         | Python         | Go                 | PHP (Proposed)               |
| ------------------- | ------------------ | -------------- | ------------------ | ---------------------------- |
| **Async Model**     | Native async/await | sync + async   | Goroutines         | Sync-only                    |
| **Streaming**       | ReadableStream     | Generator      | Iterator           | Generator                    |
| **HTTP Client**     | fetch API          | httpx          | net/http           | PSR-18                       |
| **Batching**        | Async queue        | Thread + deque | Channels           | Local queue + explicit flush |
| **SSE Support**     | ✅ Full            | ✅ Full        | ✅ Full            | ⚠️ Opt-in                    |
| **Long-Poll**       | ✅                 | ✅             | ✅                 | ✅ Default                   |
| **Builder Pattern** | Options objects    | Dataclasses    | Functional options | Fluent builders              |

---

## Open Questions for Review

1. **SSE vs Long-Poll Default**: Should SSE be supported at all given PHP's limitations, or should we document long-poll as the only supported mode?

2. **Async Support**: Should we include Swoole/ReactPHP adapters in v1, or defer to a future release?

3. **Minimum PHP Version**: PHP 8.1 (for enums, readonly properties, fibers) or PHP 8.2 (for readonly classes)?

4. **Default HTTP Client**: Should we bundle a simple cURL-based client, or require users to provide a PSR-18 implementation?

---

## Next Steps

1. Review and approve design
2. Create `packages/client-php/` directory
3. Implement core classes (DurableStream, StreamResponse)
4. Implement HttpTransport with long-poll support
5. Add to conformance test suite
6. Implement IdempotentProducer
7. Add SSE support (if approved)
8. Documentation and examples
