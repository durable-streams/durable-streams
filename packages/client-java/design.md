# Java Client Design for Durable Streams

**Status:** Implemented
**Author:** Claude
**Date:** 2026-01-09
**Updated:** 2026-01-12

## Executive Summary

This document describes the Java client library for the Durable Streams protocol, synthesizing best practices from major streaming platform SDKs (Apache Kafka, Pulsar, AWS Kinesis, etc.).

The design prioritizes:

- **Familiarity**: Patterns Java developers recognize from existing streaming SDKs
- **Type Safety**: Leveraging Java generics for compile-time safety
- **Flexibility**: Sync and async variants for all operations
- **Simplicity**: Convention over configuration with sensible defaults
- **Zero Dependencies**: Core library has no external dependencies

---

## Table of Contents

1. [Package Structure](#1-package-structure)
2. [Core API](#2-core-api)
3. [Stream Operations](#3-stream-operations)
4. [Reading Data](#4-reading-data)
5. [JSON Support](#5-json-support)
6. [Idempotent Producer](#6-idempotent-producer)
7. [Error Handling](#7-error-handling)
8. [Threading Model](#8-threading-model)
9. [Examples](#9-examples)
10. [Research Background](#10-research-background)

---

## 1. Package Structure

```
com.durablestreams
├── DurableStream              # Main client with all operations
├── ChunkIterator              # Iterator for reading chunks
├── JsonIterator<T>            # Type-safe JSON iterator
├── IdempotentProducer         # Exactly-once producer with batching
│
├── model/
│   ├── Offset                 # Opaque offset type
│   ├── Chunk                  # Raw byte chunk from server
│   ├── JsonBatch<T>           # Batch of parsed JSON items
│   ├── Metadata               # Stream metadata (from HEAD)
│   ├── AppendResult           # Result of append operation
│   └── LiveMode               # OFF, LONG_POLL, SSE
│
├── exception/
│   ├── DurableStreamException # Base exception
│   ├── StreamNotFoundException
│   ├── StreamExistsException
│   ├── SequenceConflictException
│   ├── StaleEpochException
│   └── OffsetGoneException
│
└── internal/
    ├── RetryPolicy            # Exponential backoff
    └── sse/SSEParser          # Server-Sent Events parsing
```

---

## 2. Core API

### 2.1 DurableStream

The main client for all stream operations. URL is passed to each operation directly:

```java
public final class DurableStream implements AutoCloseable {

    // Factory
    public static DurableStream create();
    public static Builder builder();

    // Create
    public void create(String url);                          // default content type
    public void create(String url, String contentType);
    public void create(String url, String contentType, Duration ttl, Instant expiresAt);

    // Append (sync + async for high throughput)
    public AppendResult append(String url, byte[] data);
    public CompletableFuture<AppendResult> appendAsync(String url, byte[] data);

    // Metadata & Delete
    public Metadata head(String url);
    public void delete(String url);

    // Read
    public ChunkIterator read(String url);
    public ChunkIterator read(String url, ReadOptions options);

    // JSON reading
    public <T> JsonIterator<T> readJson(String url, Function<String, List<T>> parser);
    public <T> JsonIterator<T> readJson(String url, Function<String, List<T>> parser, ReadOptions options);

    // Producer
    public IdempotentProducer producer(String url, String producerId);
    public IdempotentProducer producer(String url, String producerId, Config config);

    public void close();
}
```

### 2.2 Builder Pattern

```java
var client = DurableStream.builder()
    .httpClient(customHttpClient)           // Optional: custom HttpClient
    .retryPolicy(RetryPolicy.defaults())    // Optional: retry configuration
    .header("Authorization", "Bearer " + token)  // Static headers
    .header("X-Request-Id", () -> UUID.randomUUID().toString())  // Dynamic headers
    .param("api_key", apiKey)               // Query parameters
    .build();
```

---

## 3. Stream Operations

All operations take the stream URL directly.

### 3.1 Synchronous Operations

```java
var client = DurableStream.create();
String url = "https://api.example.com/streams/events";

// Create
client.create(url, "application/json");                  // With content type
client.create(url, "application/json", ttl, expiresAt);  // Full options

// Append
AppendResult result = client.append(url, data);          // byte[]
AppendResult result = client.append(url, data, seq);     // With sequence number

// Metadata
Metadata meta = client.head(url);

// Delete
client.delete(url);
```

### 3.2 Asynchronous Operations

For high-throughput appends, use `appendAsync`:

```java
// Async append
client.appendAsync(url, data)
    .thenAccept(result -> log.info("Appended at: {}", result.getNextOffset()));

// Parallel appends
var futures = urls.stream()
    .map(u -> client.appendAsync(u, data))
    .toList();
CompletableFuture.allOf(futures.toArray(new CompletableFuture[0])).join();
```

---

## 4. Reading Data

### 4.1 ChunkIterator

Implements `Iterator<Chunk>`, `Iterable<Chunk>`, and `AutoCloseable` for natural for-each usage:

```java
// Catch-up mode (default): reads all data, stops when up-to-date
try (var chunks = client.read(url)) {
    for (var chunk : chunks) {
        System.out.println(chunk.getDataAsString());
    }
}

// With ReadOptions - fluent API
try (var chunks = client.read(url, ReadOptions.from(offset).live(LiveMode.LONG_POLL).timeout(timeout))) {
    while (true) {
        Chunk chunk = chunks.poll(Duration.ofSeconds(30));
        if (chunk != null) process(chunk);
    }
}
```

### 4.2 LiveMode

| Mode        | Description                                  |
| ----------- | -------------------------------------------- |
| `OFF`       | Catch-up only, stops when up-to-date         |
| `LONG_POLL` | Server holds connection until data available |
| `SSE`       | Server-Sent Events for real-time streaming   |

### 4.3 The upToDate Contract

The `upToDate` flag indicates whether you've caught up to the stream's tail:

| Mode          | Behavior                                                       |
| ------------- | -------------------------------------------------------------- |
| **Catch-up**  | `true` on final chunk; iterator terminates                     |
| **Long-poll** | `true` when at tail; next poll will block                      |
| **SSE**       | `true` on each chunk at tail; more data may arrive immediately |

---

## 5. JSON Support

### 5.1 JsonIterator<T>

Type-safe JSON iteration with zero dependencies - you provide the parser:

```java
// With Gson
Gson gson = new Gson();
Type listType = new TypeToken<List<Event>>(){}.getType();

try (var iter = client.readJson(url, json -> gson.fromJson(json, listType))) {
    for (Event event : iter.items()) {
        process(event);
    }
}

// With Jackson
ObjectMapper mapper = new ObjectMapper();
JavaType listType = mapper.getTypeFactory()
    .constructCollectionType(List.class, Event.class);

try (var iter = client.readJson(url, json -> mapper.readValue(json, listType))) {
    iter.itemStream()
        .filter(e -> e.getType().equals("order"))
        .forEach(this::processOrder);
}
```

### 5.2 JsonBatch<T>

Each iteration yields a `JsonBatch<T>` containing:

```java
public final class JsonBatch<T> implements Iterable<T> {
    List<T> getItems();       // Parsed items
    Offset getNextOffset();   // Next read position
    boolean isUpToDate();     // At stream tail?
    Optional<String> getCursor();  // CDN cursor
}
```

### 5.3 Flattened Iteration

```java
// Iterate batches
for (JsonBatch<Event> batch : jsonIterator) {
    for (Event event : batch) { ... }
}

// Or flatten directly
for (Event event : jsonIterator.items()) {
    process(event);
}

// Or as a Stream
jsonIterator.itemStream()
    .filter(...)
    .map(...)
    .forEach(...);
```

---

## 6. Idempotent Producer

Exactly-once write semantics using `(producerId, epoch, seq)` headers.

### 6.1 Basic Usage

```java
try (var producer = client.producer(url, "my-producer")) {
    producer.append(data1);  // Fire-and-forget
    producer.append(data2);
    producer.append(data3);
    producer.flush();        // Wait for all pending
}  // close() calls flush() automatically
```

### 6.2 Configuration

```java
var config = IdempotentProducer.Config.builder()
    .epoch(0)                    // Epoch for zombie fencing
    .startingSeq(0)              // Starting sequence number
    .autoClaim(true)             // Auto-retry with epoch+1 on 403
    .maxBatchBytes(1024 * 1024)  // 1MB batches
    .lingerMs(5)                 // Wait up to 5ms to batch
    .maxInFlight(5)              // Max concurrent batches
    .onError(e -> log.error("Batch failed", e))
    .build();

var producer = client.producer(url, "my-producer", config);
```

### 6.3 Epoch Management

```java
// First run
var producer = client.producer(url, "order-service",
    Config.builder().epoch(0).build());

// After restart - increment epoch to fence out zombies
var producer = client.producer(url, "order-service",
    Config.builder().epoch(1).build());

// Or use auto-claim for serverless/ephemeral environments
var producer = client.producer(url, "lambda-function",
    Config.builder().autoClaim(true).build());
```

### 6.4 JSON Batching

For JSON streams, multiple items are automatically batched into arrays:

```java
producer.append("{\"type\":\"a\"}");
producer.append("{\"type\":\"b\"}");
// Sent as: [{"type":"a"},{"type":"b"}]
// Server flattens to separate messages
```

---

## 7. Error Handling

### 7.1 Exception Hierarchy

```java
DurableStreamException          // Base class
├── StreamNotFoundException     // 404 - Stream doesn't exist
├── StreamExistsException       // 409 - Stream already exists
├── SequenceConflictException   // 409 - Sequence regression
├── StaleEpochException         // 403 - Zombie fenced
└── OffsetGoneException         // 410 - Offset pruned
```

### 7.2 Usage

```java
try {
    client.append(url, data);
} catch (StreamNotFoundException e) {
    // Stream doesn't exist - create it first
    client.create(url, "application/json");
    client.append(url, data);
} catch (SequenceConflictException e) {
    log.error("Sequence conflict: expected {}, got {}",
        e.getExpectedSeq(), e.getReceivedSeq());
} catch (DurableStreamException e) {
    log.error("Operation failed: {} (status: {})",
        e.getMessage(), e.getStatusCode().orElse(-1));
}
```

### 7.3 Automatic Retry

The client automatically retries on:

- 429 (Rate Limited) - with exponential backoff
- 5xx (Server Errors) - with exponential backoff
- Network errors - with exponential backoff

Configure via `RetryPolicy`:

```java
var policy = RetryPolicy.builder()
    .initialDelay(Duration.ofMillis(100))
    .maxDelay(Duration.ofSeconds(60))
    .multiplier(1.3)
    .maxRetries(10)
    .build();

var client = DurableStream.builder()
    .retryPolicy(policy)
    .build();
```

---

## 8. Threading Model

### 8.1 Thread Safety

| Component            | Thread Safety   | Notes                    |
| -------------------- | --------------- | ------------------------ |
| `DurableStream`      | Thread-safe     | Shared instance          |
| `ChunkIterator`      | NOT thread-safe | Single consumer          |
| `JsonIterator`       | NOT thread-safe | Single consumer          |
| `IdempotentProducer` | Thread-safe     | Concurrent `append()` OK |

### 8.2 Async Execution

Async operations use the HttpClient's executor (default: cached thread pool with daemon threads).

---

## 9. Examples

### 9.1 Simple Read

```java
var client = DurableStream.create();
String url = "https://api.example.com/streams/events";

for (var chunk : client.read(url)) {
    System.out.println("Data: " + chunk.getDataAsString());
    System.out.println("Next offset: " + chunk.getNextOffset());
}
```

### 9.2 Live Tailing with JSON

```java
record Event(String type, String data) {}

var client = DurableStream.builder()
    .header("Authorization", "Bearer " + token)
    .build();

Gson gson = new Gson();
Type listType = new TypeToken<List<Event>>(){}.getType();

var options = ReadOptions.fromNow().live(LiveMode.SSE);
try (var iter = client.readJson(url, json -> gson.fromJson(json, listType), options)) {
    for (Event event : iter.items()) {
        System.out.printf("Event: %s - %s%n", event.type(), event.data());
    }
}
```

### 9.3 Reliable Producer

```java
var config = IdempotentProducer.Config.builder()
    .epoch(getEpochFromStorage())
    .maxBatchBytes(1024 * 1024)
    .lingerMs(5)
    .maxInFlight(5)
    .onError(e -> alertOps(e))
    .build();

try (var producer = client.producer(ORDERS_URL, "order-service", config)) {
    for (Order order : orderStream()) {
        producer.append(gson.toJson(order));
    }
}  // Flushes on close
```

### 9.4 Async Operations

```java
// Parallel appends for high throughput
var futures = urls.stream()
    .map(u -> client.appendAsync(u, data))
    .toList();
CompletableFuture.allOf(futures.toArray(new CompletableFuture[0]))
    .thenRun(() -> log.info("All appends complete"));
```

---

## 10. Research Background

The design was informed by analysis of these streaming platforms:

| Pattern         | Kafka | Pulsar | Kinesis | Pub/Sub | Event Hubs | NATS |
| --------------- | ----- | ------ | ------- | ------- | ---------- | ---- |
| Builder Pattern | ✓     | ✓      | ✓       | ✓       | ✓          | ✓    |
| Sync + Async    | ✓     | ✓      | ✓       | ✓       | ✓          | ✓    |
| Auto Batching   | ✓     | ✓      | -       | ✓       | ✓          | -    |
| Offset Tracking | ✓     | ✓      | ✓       | ✓       | ✓          | ✓    |
| Backoff/Retry   | ✓     | ✓      | ✓       | ✓       | ✓          | ✓    |

### Key Patterns Adopted

1. **Builder pattern** (Kafka, Pulsar, Azure) - For configuration
2. **Iterator + Iterable + AutoCloseable** - For natural for-each with resource management
3. **Fire-and-forget with flush** (Kafka) - For IdempotentProducer
4. **Poll-based consumption** (Kafka) - For ChunkIterator
5. **Epoch-based fencing** (Kafka) - For exactly-once semantics

### Anti-Patterns Avoided

1. **Connection-per-message** - Reuse HttpClient
2. **Missing timeouts** - All operations have timeouts
3. **Blocking in callbacks** - Async variants available
4. **Shared mutable state** - Iterators are single-consumer

---

## References

- [Durable Streams Protocol Specification](../../PROTOCOL.md)
- [Apache Kafka Java Client](https://docs.confluent.io/kafka-clients/java/current/overview.html)
- [Apache Pulsar Java Client](https://pulsar.apache.org/docs/next/client-libraries-java/)
