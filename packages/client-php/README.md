# Durable Streams PHP Client

PHP client for the [Durable Streams](https://github.com/durable-streams/durable-streams) protocol—HTTP-based durable streams for reliable data delivery to client applications.

## Installation

```bash
composer require durable-streams/client
```

**Requirements:** PHP 8.1+

## What is Durable Streams?

Durable Streams is an open protocol for real-time sync to client applications. Think "append-only log as a service" with offset-based resumability and exactly-once semantics.

**The problem:** WebSocket and SSE connections are easy to start, but fragile in practice. Tabs get suspended, networks flap, devices switch, pages refresh. When that happens, you either lose in-flight data or build a bespoke resume protocol.

**The solution:** Durable Streams provides a simple HTTP-based protocol where every position in the stream has an offset. Clients track their offset and resume from where they left off—no data loss, no re-processing.

## Quick Start

### Reading from a Stream

```php
<?php

use function DurableStreams\stream;

// Read all events from a stream
$response = stream([
    'url' => 'https://api.example.com/streams/events',
    'offset' => '-1', // Start from beginning
]);

foreach ($response->jsonStream() as $event) {
    echo "Event: " . json_encode($event) . "\n";
}
```

### Live Tailing with Long-Poll

```php
<?php

use DurableStreams\LiveMode;
use function DurableStreams\stream;

// Subscribe to live updates
$response = stream([
    'url' => 'https://api.example.com/streams/events',
    'offset' => $lastOffset ?? '-1',
    'live' => LiveMode::LongPoll,
]);

// Iterate directly over batches
foreach ($response->jsonBatches() as $batch) {
    foreach ($batch as $event) {  // JsonBatch is iterable
        processEvent($event);
    }
    saveCheckpoint($batch->offset);
}
```

### Writing with Exactly-Once Semantics

```php
<?php

use DurableStreams\IdempotentProducer;

$producer = new IdempotentProducer(
    url: 'https://api.example.com/streams/events',
    producerId: 'order-service-1',
    autoClaim: true,
);

// Queue events locally (no network I/O)
foreach ($orders as $order) {
    $producer->enqueue([
        'type' => 'order.created',
        'orderId' => $order->id,
        'total' => $order->total,
    ]);
}

// Send all queued events (blocks until complete)
$producer->close();
```

## Overview

The PHP client provides two main APIs:

1. **`stream()` function** - Read-only API for consuming streams with generator-based iteration
2. **`IdempotentProducer` class** - High-throughput producer with exactly-once write semantics

## Key Features

- **Exactly-Once Writes** - `IdempotentProducer` provides Kafka-style exactly-once semantics with automatic deduplication
- **Automatic Batching** - Multiple writes are batched together for high throughput
- **Typed Iteration** - `chunks()` and `jsonBatches()` methods provide clean, typed iteration with offset tracking
- **Generator-Based Streaming** - Memory-efficient consumption using PHP's native `yield` pattern
- **Resumable** - Offset-based reads let you resume from any point
- **Dynamic Headers** - Support for callable headers (e.g., for token refresh)
- **Error Recovery** - `onError` callback for handling recoverable errors like 401s
- **PSR-18 Compatible** - Use your own HTTP client or the built-in cURL client
- **PSR-3 Logging** - Optional structured logging for `IdempotentProducer`

## Reading Streams

### Basic Read (Catch-up Mode)

Read all existing data and stop when caught up:

```php
<?php

use function DurableStreams\stream;

$response = stream([
    'url' => 'https://api.example.com/streams/events',
    'offset' => '-1',
]);

// Get all items as an array
$events = $response->json();

// Or iterate with generators (memory-efficient)
foreach ($response->jsonStream() as $event) {
    processEvent($event);
}

// Save offset for later resumption
$savedOffset = $response->getOffset();
```

### Resume from Saved Offset

```php
<?php

$response = stream([
    'url' => 'https://api.example.com/streams/events',
    'offset' => $savedOffset, // Resume where we left off
]);

foreach ($response->jsonStream() as $event) {
    processEvent($event);
}
```

### Live Tailing (Long-Poll)

Subscribe to live updates—the request blocks until new data arrives:

```php
<?php

use DurableStreams\LiveMode;

$response = stream([
    'url' => 'https://api.example.com/streams/events',
    'offset' => 'now',             // Start from current position
    'live' => LiveMode::LongPoll,  // Keep polling for new data
]);

// This loop runs forever (until cancelled)
foreach ($response->jsonBatches() as $batch) {
    foreach ($batch as $event) {
        handleEvent($event);
    }
    saveCheckpoint($batch->offset);
}
```

### Dynamic Headers (Token Refresh)

Headers can be callables that are evaluated before each request:

```php
<?php

$response = stream([
    'url' => 'https://api.example.com/streams/events',
    'headers' => [
        // Called before each request
        'Authorization' => fn() => 'Bearer ' . getCurrentToken(),
    ],
]);
```

### Error Recovery

Handle recoverable errors like authentication failures:

```php
<?php

use DurableStreams\LiveMode;
use DurableStreams\Exception\UnauthorizedException;

$response = stream([
    'url' => 'https://api.example.com/streams/events',
    'live' => LiveMode::LongPoll,
    'headers' => [
        'Authorization' => fn() => 'Bearer ' . $token,
    ],
    'onError' => function ($error) use (&$token) {
        if ($error instanceof UnauthorizedException) {
            $token = refreshToken(); // Get a new token
            return [];               // Retry the request
        }
        return null; // Stop on other errors
    },
]);
```

### Configurable Retry

```php
<?php

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

## Writing to Streams

### IdempotentProducer (Recommended)

For reliable, high-throughput writes with exactly-once semantics:

```php
<?php

use DurableStreams\IdempotentProducer;

$producer = new IdempotentProducer(
    url: 'https://api.example.com/streams/events',
    producerId: 'worker-1',
    epoch: 0,
    autoClaim: true,        // Auto-recover from epoch conflicts
    maxBatchBytes: 64 * 1024, // 64KB batches
);

// enqueue() queues locally - no network I/O
$producer->enqueue(['type' => 'user.created', 'userId' => 123]);
$producer->enqueue(['type' => 'user.updated', 'userId' => 123]);

// flush() sends all queued data (blocks until complete)
$producer->flush();

// Or close() which flushes and prevents further writes
$producer->close();
```

**Why use IdempotentProducer?**

- **Exactly-once delivery** - Server deduplicates using `(producerId, epoch, seq)` tuple
- **Automatic batching** - Multiple items batched into single HTTP requests
- **Zombie fencing** - Stale producers are rejected, preventing split-brain scenarios
- **Network resilience** - Safe to retry on network errors (server deduplicates)

### Batch Size Limits

The producer auto-flushes when batch limits are reached:

```php
<?php

$producer = new IdempotentProducer(
    url: $url,
    producerId: 'worker-1',
    maxBatchBytes: 1024 * 1024,  // 1MB max batch size
    maxBatchItems: 1000,          // 1000 items max per batch
);

// If adding this item would exceed limits, flush happens automatically
$producer->enqueue($largeEvent);
```

### Epoch Management (Zombie Fencing)

Epochs prevent "zombie" producers from writing after failover:

```php
<?php

// If another producer claims a higher epoch, this producer gets a 403
// With autoClaim: true, it automatically claims epoch+1 and retries

$producer = new IdempotentProducer(
    url: $url,
    producerId: 'worker-1',
    autoClaim: true,  // Automatically claim new epoch on conflict
);

// Or handle manually
$producer = new IdempotentProducer(
    url: $url,
    producerId: 'worker-1',
    autoClaim: false,
);

try {
    $producer->flush();
} catch (StaleEpochException $e) {
    // Another producer has taken over
    echo "Fenced by epoch " . $e->getCurrentEpoch();
}
```

### Script Lifecycle Safety

Always flush before script ends:

```php
<?php

$producer = new IdempotentProducer($url, 'worker-1');

try {
    foreach ($events as $event) {
        $producer->enqueue($event);
    }
} finally {
    $producer->close(); // Ensures flush on success or exception
}
```

## StreamResponse Methods

### Iteration

```php
// Recommended: Iterate over typed chunks (one per HTTP response)
foreach ($response->chunks() as $chunk) {
    if ($chunk->hasData()) {
        echo $chunk->data;
    }
    saveCheckpoint($chunk->offset);
}

// Recommended: Iterate over JSON batches (matches TypeScript subscribeJson)
foreach ($response->jsonBatches() as $batch) {
    foreach ($batch->items as $item) {
        processItem($item);
    }
    saveCheckpoint($batch->offset);
}

// Low-level: Iterate over individual JSON items
foreach ($response->jsonStream() as $item) {
    processItem($item);
}
```

### Collecting All Data

Only works for non-live streams (would block forever on live streams):

```php
// Get all JSON items as array
$items = $response->json();

// Get raw body as string
$body = $response->body();
```

### State Properties

```php
$response->getOffset();    // Current offset
$response->isUpToDate();   // Whether caught up to stream head
$response->isLive();       // Whether this is a live (infinite) stream
$response->getStatus();    // HTTP status code
```

### Cancellation

Soft cancel—stops after current request completes:

```php
// In a signal handler
$response->cancel();
```

## CLI Consumer Example

Long-running consumer with graceful shutdown:

```php
#!/usr/bin/env php
<?php

use function DurableStreams\stream;
use DurableStreams\LiveMode;

$running = true;
pcntl_signal(SIGTERM, function () use (&$running) { $running = false; });
pcntl_signal(SIGINT, function () use (&$running) { $running = false; });

$response = stream([
    'url' => 'https://api.example.com/streams/events',
    'offset' => loadCheckpoint() ?? '-1',
    'live' => LiveMode::Auto,
]);

foreach ($response->jsonBatches() as $batch) {
    pcntl_signal_dispatch(); // Check for signals

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

## Using PSR-18 HTTP Clients

The built-in cURL client works out of the box, but you can use any PSR-18 compatible client:

```php
<?php

use DurableStreams\Internal\Psr18HttpClient;
use GuzzleHttp\Client;
use GuzzleHttp\Psr7\HttpFactory;

$guzzle = new Client();
$factory = new HttpFactory();

$httpClient = new Psr18HttpClient(
    client: $guzzle,
    requestFactory: $factory,
    streamFactory: $factory,
);

$response = stream([
    'url' => 'https://api.example.com/streams/events',
    'client' => $httpClient,
]);
```

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

### Exception Properties

```php
try {
    // ...
} catch (DurableStreamException $e) {
    echo $e->getMessage();
    echo $e->getErrorCode();     // e.g., 'UNAUTHORIZED'
    echo $e->getHttpStatus();    // e.g., 401
    echo $e->isRetryable();      // true for 429, 5xx
    print_r($e->getHeaders());   // Response headers
}

// RateLimitedException has retry info
catch (RateLimitedException $e) {
    $retryAfter = $e->getRetryAfter(); // Seconds to wait
}
```

## Comparison with Other Clients

| Feature         | TypeScript     | Python         | Go         | PHP                 |
| --------------- | -------------- | -------------- | ---------- | ------------------- |
| **Async Model** | async/await    | sync + async   | Goroutines | Sync-only           |
| **Streaming**   | ReadableStream | Generator      | Iterator   | Generator           |
| **HTTP Client** | fetch          | httpx          | net/http   | cURL + PSR-18       |
| **Batching**    | Async queue    | Thread + deque | Channels   | Local queue + flush |
| **SSE Support** | Yes            | Yes            | Yes        | No (long-poll only) |

**PHP-specific limitations** (due to synchronous execution model):

- No `lingerMs` - batches only flush on size limits or explicit `flush()` call (no background timer)
- No `maxInFlight` - batches sent synchronously, not pipelined
- No SSE - use `LiveMode::LongPoll` or `LiveMode::Auto` instead

## Protocol

Durable Streams is built on a simple HTTP-based protocol:

- `PUT /stream/{path}` - Create a new stream
- `POST /stream/{path}` - Append data
- `GET /stream/{path}?offset=X` - Read from offset
- `GET /stream/{path}?offset=X&live=long-poll` - Live tail
- `DELETE /stream/{path}` - Delete stream
- `HEAD /stream/{path}` - Get metadata

See [PROTOCOL.md](https://github.com/durable-streams/durable-streams/blob/main/PROTOCOL.md) for the full specification.

## License

Apache 2.0

## Links

- [Durable Streams GitHub](https://github.com/durable-streams/durable-streams)
- [Protocol Specification](https://github.com/durable-streams/durable-streams/blob/main/PROTOCOL.md)
- [TypeScript Client](https://www.npmjs.com/package/@durable-streams/client)
- [Python Client](https://pypi.org/project/durable-streams/)
