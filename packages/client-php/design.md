# PHP Client Design for Durable Streams

## Executive Summary

This document describes the PHP client design for the Durable Streams protocol, based on research of PHP SDKs for Kafka, Redis Streams, NATS JetStream, and other streaming platforms.

**Key Design Principles:**

1. **Synchronous I/O** - All network I/O blocks; no background threads or async runtime required
2. **Simple configuration** - Constructor parameters and array options (matching TypeScript/Python patterns)
3. **Generator-based iteration** - Memory-efficient streaming (universal PHP pattern)
4. **Local batching with explicit flush** - `enqueue()` queues locally, `flush()` does I/O
5. **PSR-18 optional** - Built-in cURL client with optional PSR-18 adapter

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
                    │  HttpClientInterface│
                    └─────────────────────┘
                               │
                    ┌──────────┴──────────┐
                    ▼                     ▼
             ┌────────────┐        ┌────────────┐
             │  HttpClient│        │Psr18Client │
             │  (cURL)    │        │ (adapter)  │
             └────────────┘        └────────────┘
```

---

## Core Classes

### Class Diagram

```
DurableStream (static factory methods)
    ├── create(): DurableStream
    ├── connect(): DurableStream
    ├── headStatic(): HeadResult
    └── deleteStatic(): void

DurableStream (instance)
    ├── head(): HeadResult
    ├── append(mixed $data): AppendResult
    ├── read(): StreamResponse
    ├── delete(): void
    └── close(): void

IdempotentProducer
    ├── enqueue(mixed $data): void  (queues locally, no I/O)
    ├── flush(): void               (sends batches, blocks until complete)
    ├── restart(): void
    └── close(): void

StreamResponse (read session)
    ├── chunks(): Generator<StreamChunk>     (recommended)
    ├── jsonBatches(): Generator<JsonBatch>  (recommended for JSON)
    ├── getIterator(): Generator<string>     (low-level)
    ├── jsonStream(): Generator<mixed>       (low-level)
    ├── json(): array               (throws on live streams)
    ├── body(): string              (throws on live streams)
    ├── cancel(): void              (soft-cancel)
    ├── getOffset(): string
    └── isLive(): bool

StreamChunk (implements Stringable)
    ├── data: ?string
    ├── offset: string
    ├── upToDate: bool
    ├── status: int
    ├── hasData(): bool
    └── __toString(): string

JsonBatch (implements Countable, IteratorAggregate)
    ├── items: array
    ├── offset: string
    ├── upToDate: bool
    ├── status: int
    ├── hasItems(): bool
    ├── count(): int
    └── getIterator(): Traversable

LiveMode (enum)
    ├── Off         (catch-up mode)
    ├── LongPoll    (block until new data)
    ├── Auto        (maps to LongPoll)
    ├── toQueryValue(): string|false
    └── isLive(): bool

RetryOptions
    ├── maxRetries: int
    ├── initialDelayMs: int
    ├── maxDelayMs: int
    └── multiplier: float
```

---

## API Design

### 1. Read-Only Function

Standalone function for consumers who don't write (primary API for most use cases):

```php
<?php

namespace DurableStreams;

/**
 * Standalone read-only stream function
 *
 * @param array{
 *   url: string,
 *   offset?: string,
 *   live?: LiveMode,
 *   headers?: array<string, string|callable>,
 *   timeout?: float,
 *   retry?: RetryOptions,
 *   onError?: callable(DurableStreamException): ?array,
 * } $options
 */
function stream(array $options): StreamResponse;
```

### 2. IdempotentProducer

Batching producer with exactly-once semantics:

```php
<?php

namespace DurableStreams;

use Psr\Log\LoggerInterface;

final class IdempotentProducer
{
    public function __construct(
        string $url,
        string $producerId,
        int $epoch = 0,
        bool $autoClaim = false,
        int $maxBatchBytes = 1024 * 1024,
        int $maxBatchItems = 1000,
        ?string $contentType = null,
        ?HttpClientInterface $client = null,
        ?LoggerInterface $logger = null,  // PSR-3 logger
    );

    public function enqueue(mixed $data): void;
    public function flush(): void;
    public function restart(): void;
    public function getEpoch(): int;
    public function getSeq(): int;
    public function close(): void;
}
```

### 3. StreamResponse

Generator-based iteration with typed chunks:

```php
<?php

namespace DurableStreams;

final class StreamResponse implements \IteratorAggregate
{
    // Recommended iteration methods
    public function chunks(): \Generator;      // yields StreamChunk
    public function jsonBatches(): \Generator; // yields JsonBatch

    // Low-level iteration
    public function getIterator(): \Generator; // yields string
    public function jsonStream(): \Generator;  // yields mixed

    // Collect all (throws on live streams)
    public function json(): array;
    public function body(): string;

    // Control
    public function cancel(): void;
    public function getOffset(): string;
    public function isUpToDate(): bool;
    public function isLive(): bool;
}

final class StreamChunk implements \Stringable
{
    public readonly ?string $data;
    public readonly string $offset;
    public readonly bool $upToDate;
    public readonly int $status;
    public function hasData(): bool;
    public function __toString(): string;
}

final class JsonBatch implements \Countable, \IteratorAggregate
{
    public readonly array $items;
    public readonly string $offset;
    public readonly bool $upToDate;
    public readonly int $status;
    public function hasItems(): bool;
    public function count(): int;
    public function getIterator(): \Traversable;
}
```

### 4. RetryOptions

Configurable retry behavior:

```php
<?php

namespace DurableStreams;

final class RetryOptions
{
    public function __construct(
        int $maxRetries = 3,
        int $initialDelayMs = 100,
        int $maxDelayMs = 5000,
        float $multiplier = 2.0,
    );

    public static function default(): self;
    public static function none(): self;
}
```

---

## Error Handling

### Exception Hierarchy

```
DurableStreamException (base)
├── StreamNotFoundException        (404)
├── StreamExistsException          (409 on create)
├── SeqConflictException           (409 on append)
├── UnauthorizedException          (401)
├── RateLimitedException           (429)
├── StaleEpochException            (producer epoch error)
└── MessageTooLargeException       (item exceeds batch size)
```

### Exception Interface

```php
<?php

namespace DurableStreams\Exception;

class DurableStreamException extends \Exception
{
    public function getErrorCode(): ?string;
    public function getHttpStatus(): ?int;
    public function getHeaders(): array;
    public function isRetryable(): bool;
}

class RateLimitedException extends DurableStreamException
{
    public function getRetryAfter(): ?int;
}
```

---

## HTTP Client Support

### Built-in cURL Client (Default)

High-performance cURL client with connection pooling:

```php
use DurableStreams\Internal\HttpClient;

$client = new HttpClient(
    timeout: 30.0,
    connectTimeout: 10.0,
    retryOptions: RetryOptions::default(),
);
```

### PSR-18 Adapter (Optional)

For users who want to use their own HTTP client:

```php
use DurableStreams\Internal\Psr18HttpClient;
use GuzzleHttp\Psr7\HttpFactory;

$psr18Client = new \GuzzleHttp\Client();
$factory = new HttpFactory();

$client = new Psr18HttpClient(
    client: $psr18Client,
    requestFactory: $factory,
    streamFactory: $factory,
    retryOptions: RetryOptions::default(),
);
```

---

## Long-Poll Support

**Note:** SSE is not supported. PHP's synchronous model makes SSE impractical for most use cases. Long-poll is the only supported live mode.

### Termination Behavior

- `LiveMode::Off` (catch-up): Stop when `upToDate` is true
- `LiveMode::LongPoll`: Keep polling forever (until cancelled or error)
- `LiveMode::Auto`: Maps to `LongPoll` in PHP

---

## Example Usage

### Basic Consumer

```php
<?php

use function DurableStreams\stream;

$response = stream([
    'url' => 'https://api.example.com/streams/events',
    'offset' => '-1',
]);

foreach ($response->jsonStream() as $event) {
    processEvent($event);
}
```

### Live Consumer with Dynamic Headers

```php
<?php

use function DurableStreams\stream;
use DurableStreams\LiveMode;
use DurableStreams\Exception\UnauthorizedException;

$response = stream([
    'url' => 'https://api.example.com/streams/events',
    'offset' => 'now',
    'live' => LiveMode::LongPoll,
    'headers' => [
        // Dynamic header - called before each request
        'Authorization' => fn() => 'Bearer ' . getCurrentToken(),
    ],
    'onError' => function ($error) {
        if ($error instanceof UnauthorizedException) {
            refreshToken();
            return []; // Retry with refreshed token
        }
        return null; // Stop on other errors
    },
]);

foreach ($response->jsonStream() as $event) {
    handleEvent($event);
}
```

### Idempotent Producer

```php
<?php

use DurableStreams\IdempotentProducer;

$producer = new IdempotentProducer(
    url: 'https://api.example.com/streams/events',
    producerId: 'order-processor',
    epoch: 0,
    autoClaim: true,
    maxBatchBytes: 64 * 1024,
);

try {
    foreach ($orders as $order) {
        $producer->enqueue(['type' => 'order.created', 'order' => $order]);
    }
} finally {
    $producer->close(); // Always flush before script ends
}
```

### Custom Retry Configuration

```php
<?php

use function DurableStreams\stream;
use DurableStreams\RetryOptions;

$response = stream([
    'url' => 'https://api.example.com/streams/events',
    'retry' => new RetryOptions(
        maxRetries: 5,
        initialDelayMs: 200,
        maxDelayMs: 10000,
        multiplier: 2.0,
    ),
]);
```

### Long-Running CLI Consumer

```php
#!/usr/bin/env php
<?php

use function DurableStreams\stream;
use DurableStreams\LiveMode;

$running = true;
pcntl_signal(SIGTERM, function () use (&$running) {
    $running = false;
});
pcntl_signal(SIGINT, function () use (&$running) {
    $running = false;
});

$response = stream([
    'url' => 'https://api.example.com/streams/events',
    'offset' => $lastOffset ?? '-1',
    'live' => LiveMode::Auto,
]);

foreach ($response->jsonBatches() as $batch) {
    pcntl_signal_dispatch();

    if (!$running) {
        $response->cancel();
        break;
    }

    foreach ($batch->items as $event) {
        processEvent($event);
    }
    saveCheckpoint($batch->offset);
}

echo "Graceful shutdown complete\n";
```

---

## Package Structure

```
packages/client-php/
├── composer.json
├── design.md
├── src/
│   ├── DurableStream.php
│   ├── IdempotentProducer.php
│   ├── StreamResponse.php
│   ├── StreamChunk.php
│   ├── JsonBatch.php
│   ├── RetryOptions.php
│   ├── functions.php
│   │
│   ├── Result/
│   │   ├── HeadResult.php
│   │   └── AppendResult.php
│   │
│   ├── Exception/
│   │   ├── DurableStreamException.php
│   │   ├── StreamNotFoundException.php
│   │   ├── StreamExistsException.php
│   │   ├── SeqConflictException.php
│   │   ├── UnauthorizedException.php
│   │   ├── RateLimitedException.php
│   │   ├── StaleEpochException.php
│   │   └── MessageTooLargeException.php
│   │
│   └── Internal/
│       ├── HttpClientInterface.php
│       ├── HttpClient.php
│       ├── Psr18HttpClient.php
│       ├── HttpErrorHandler.php
│       └── HttpResponse.php
│
└── tests/
    └── Conformance/
```

---

## Comparison with Other Clients

| Feature           | TypeScript         | Python         | Go                 | PHP                          |
| ----------------- | ------------------ | -------------- | ------------------ | ---------------------------- |
| **Async Model**   | Native async/await | sync + async   | Goroutines         | Sync-only                    |
| **Streaming**     | ReadableStream     | Generator      | Iterator           | Generator                    |
| **HTTP Client**   | fetch API          | httpx          | net/http           | cURL + PSR-18 optional       |
| **Batching**      | Async queue        | Thread + deque | Channels           | Local queue + explicit flush |
| **SSE Support**   | Yes                | Yes            | Yes                | No (long-poll only)          |
| **Long-Poll**     | Yes                | Yes            | Yes                | Yes (default)                |
| **Configuration** | Options objects    | kwargs         | Functional options | Constructor params + arrays  |
| **lingerMs**      | Yes                | Yes            | Yes                | No (sync model)              |
| **maxInFlight**   | Yes                | Yes            | Yes                | No (sync model)              |

---

## Design Decisions

### Why No Builder Pattern?

The TypeScript and Python clients use flat options objects and kwargs respectively—not fluent builders. PHP 8's named arguments provide a clean API without builder ceremony:

```php
// Clean and explicit with named arguments
$producer = new IdempotentProducer(
    url: $url,
    producerId: 'worker-1',
    autoClaim: true,
);

// vs. verbose builder pattern
$producer = IdempotentProducer::create()
    ->withUrl($url)
    ->withProducerId('worker-1')
    ->withAutoClaim(true)
    ->build();
```

### Why No SSE?

PHP's synchronous execution model makes SSE impractical:

- PSR-18 doesn't standardize streaming response bodies
- Most PHP HTTP clients buffer entire responses
- Long-poll provides equivalent functionality with better compatibility

### Why cURL Default + PSR-18 Optional?

- cURL provides connection pooling out of the box
- PSR-18 allows integration with existing HTTP stacks
- Users can choose based on their needs
