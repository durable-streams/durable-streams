# Java Client Design for Durable Streams

**Status:** RFC / Design Review
**Author:** Claude
**Date:** 2026-01-09

## Executive Summary

This document presents a unified design for a Java client library for the Durable Streams protocol, synthesizing best practices from 10 major streaming platform SDKs: Apache Kafka, Redis Streams, NATS JetStream, Apache Pulsar, AWS Kinesis, Google Cloud Pub/Sub, Azure Event Hubs, RabbitMQ Streams, Apache Flink, and Redpanda.

The design prioritizes:
- **Familiarity**: Patterns Java developers recognize from existing streaming SDKs
- **Type Safety**: Leveraging Java generics for compile-time safety
- **Flexibility**: Sync, async, and reactive variants
- **Simplicity**: Convention over configuration with sensible defaults
- **Performance**: Connection pooling, batching, and zero-copy where possible

---

## Table of Contents

1. [Research Summary](#1-research-summary)
2. [Core Design Principles](#2-core-design-principles)
3. [Package Structure](#3-package-structure)
4. [API Design](#4-api-design)
5. [Configuration](#5-configuration)
6. [Error Handling](#6-error-handling)
7. [Streaming Modes](#7-streaming-modes)
8. [Idempotent Producer](#8-idempotent-producer)
9. [JSON Support](#9-json-support)
10. [Threading Model](#10-threading-model)
11. [Resource Management](#11-resource-management)
12. [Examples](#12-examples)
13. [Future Considerations](#13-future-considerations)

---

## 1. Research Summary

### 1.1 Cross-Platform Pattern Analysis

| Pattern | Kafka | Pulsar | Kinesis | Pub/Sub | Event Hubs | NATS | RabbitMQ | Redis |
|---------|-------|--------|---------|---------|------------|------|----------|-------|
| Builder Pattern | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Sync + Async APIs | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Consumer Groups | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | - | ✓ |
| Auto Batching | ✓ | ✓ | - | ✓ | ✓ | - | ✓ | - |
| Offset Tracking | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Backoff/Retry | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Future/Callback | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |

### 1.2 Key Insights by Platform

**Apache Kafka**
- Poll-based consumer loop driven by `poll()` method
- Async producer with `send()` returning `Future<RecordMetadata>`
- Idempotent producer pattern: `(producerId, epoch, seq)` headers
- Properties-based configuration

**Apache Pulsar**
- Fluent builder pattern: `client.newProducer().topic(t).create()`
- Multiple subscription types (Exclusive, Shared, Failover, Key_Shared)
- Built-in schema registry with type-safe generics
- TableView for compacted topic state

**AWS Kinesis**
- SDK 2.x builder pattern with immutable request objects
- KCL (Kinesis Client Library) for managed consumption
- Shard-based parallelism model

**Google Cloud Pub/Sub**
- Publisher/Subscriber as long-lived reusable objects
- MessageReceiver callback interface
- Built-in batching with configurable thresholds
- Automatic message acknowledgment management

**Azure Event Hubs**
- EventHubClientBuilder for all client types
- Partition-based consumption with EventPosition
- Consumer group isolation
- Checkpoint store abstraction

**NATS JetStream**
- JetStream context as entry point
- Pull consumers as primary consumption model
- Durable vs ephemeral consumer distinction
- Fetch/Consume/Next consumption patterns

**RabbitMQ Streams**
- Environment as central entry point
- Producer/Consumer builders from environment
- Automatic connection recovery
- Super streams for partitioning

**Redis Streams (Lettuce)**
- Sync, async, and reactive APIs from same connection
- Consumer groups with XREADGROUP
- StatefulRedisConnection pattern

### 1.3 Common Anti-Patterns to Avoid

1. **Channel-per-message** (RabbitMQ) - Creating connections/resources per operation
2. **Missing timeouts** - Unbounded waits causing resource leaks
3. **Ignoring backpressure** - Overwhelming consumers with data
4. **Shared mutable state** - Thread-safety issues with connection objects
5. **Blocking in callbacks** - Holding up event loops

---

## 2. Core Design Principles

### 2.1 Convention Over Configuration

```java
// Simplest possible usage
var stream = DurableStream.connect("https://api.example.com/streams/my-stream");
for (var message : stream.read()) {
    process(message);
}
```

### 2.2 Progressive Disclosure

```java
// Simple → Full control
DurableStream.connect(url)                           // Defaults
DurableStream.builder().url(url).build()             // Builder
DurableStream.builder().url(url).httpClient(custom)  // Full control
```

### 2.3 Sync and Async Parity

Every operation available in both sync and async variants:

```java
// Sync
stream.append(data);

// Async
stream.appendAsync(data).thenAccept(result -> ...);
```

### 2.4 Fail-Fast with Recoverable Errors

```java
try {
    stream.append(data);
} catch (StreamNotFoundException e) {
    // Non-recoverable: stream doesn't exist
} catch (RateLimitedException e) {
    // Recoverable: includes retryAfter()
}
```

---

## 3. Package Structure

```
com.durablestreams
├── DurableStream              # Main entry point (like Pulsar's PulsarClient)
├── DurableStreamBuilder       # Fluent configuration builder
├── StreamHandle               # Handle for read/write operations
├── StreamReader               # Read-only operations
├── StreamResponse             # Single response from a read
│
├── producer/
│   ├── IdempotentProducer     # Fire-and-forget producer
│   ├── ProducerBuilder        # Producer configuration
│   ├── ProducerConfig         # Immutable config object
│   └── AppendResult           # Result of append operation
│
├── consumer/
│   ├── StreamConsumer         # Event-driven consumption
│   ├── ConsumerBuilder        # Consumer configuration
│   ├── MessageHandler         # Callback interface
│   ├── ChunkIterator          # Iterator over raw chunks
│   └── JsonIterator<T>        # Type-safe JSON iterator
│
├── config/
│   ├── StreamConfig           # Stream-level configuration
│   ├── BackoffConfig          # Retry/backoff settings
│   ├── BatchConfig            # Batching settings
│   └── HttpConfig             # HTTP client settings
│
├── model/
│   ├── Offset                 # Opaque offset type
│   ├── Message<T>             # Message with metadata
│   ├── Chunk                  # Raw byte chunk
│   └── JsonBatch<T>           # Batch of JSON messages
│
├── exception/
│   ├── DurableStreamException # Base exception
│   ├── StreamNotFoundException
│   ├── StreamConflictException
│   ├── SequenceConflictException
│   ├── StaleEpochException
│   ├── RateLimitedException
│   └── OffsetGoneException
│
└── spi/
    ├── HttpClientProvider     # Custom HTTP client SPI
    ├── Serializer<T>          # Serialization SPI
    └── OffsetStore            # Offset persistence SPI
```

---

## 4. API Design

### 4.1 Entry Point: DurableStream

Following the **Environment/Client pattern** from Pulsar, RabbitMQ, and NATS:

```java
public final class DurableStream implements AutoCloseable {

    // Quick start - static factory methods
    public static StreamHandle connect(String url);
    public static StreamHandle connect(URI url);

    // Full configuration - builder pattern
    public static DurableStreamBuilder builder();

    // Instance methods when using builder
    public StreamHandle stream(String url);
    public StreamHandle stream(URI url);
    public IdempotentProducer newProducer(String url);
    public StreamConsumer newConsumer(String url);

    @Override
    public void close();
}
```

### 4.2 Builder Pattern (Like Kafka/Pulsar/Azure)

```java
public final class DurableStreamBuilder {

    // HTTP configuration
    public DurableStreamBuilder httpClient(HttpClient client);
    public DurableStreamBuilder connectTimeout(Duration timeout);
    public DurableStreamBuilder readTimeout(Duration timeout);

    // Authentication (extensible)
    public DurableStreamBuilder authentication(Authentication auth);
    public DurableStreamBuilder bearerToken(String token);
    public DurableStreamBuilder bearerToken(Supplier<String> tokenSupplier);
    public DurableStreamBuilder basicAuth(String username, String password);

    // Headers (static and dynamic like existing clients)
    public DurableStreamBuilder header(String name, String value);
    public DurableStreamBuilder header(String name, Supplier<String> valueSupplier);
    public DurableStreamBuilder headers(Map<String, String> headers);

    // Retry configuration
    public DurableStreamBuilder backoff(BackoffConfig config);
    public DurableStreamBuilder maxRetries(int retries);

    // Content type default
    public DurableStreamBuilder defaultContentType(String contentType);

    // JSON configuration
    public DurableStreamBuilder objectMapper(ObjectMapper mapper);

    public DurableStream build();
}
```

### 4.3 StreamHandle: Read/Write Operations

```java
public interface StreamHandle extends AutoCloseable {

    // --- Metadata ---
    URI url();
    Optional<StreamMetadata> metadata();
    CompletableFuture<StreamMetadata> metadataAsync();

    // --- Create ---
    void create();
    void create(CreateOptions options);
    CompletableFuture<Void> createAsync();
    CompletableFuture<Void> createAsync(CreateOptions options);

    // --- Append (Simple) ---
    AppendResult append(byte[] data);
    AppendResult append(String data);
    <T> AppendResult append(T data);  // Uses configured ObjectMapper
    CompletableFuture<AppendResult> appendAsync(byte[] data);

    // --- Read (Iterator-based, like Kafka's poll pattern) ---
    ChunkIterator read();
    ChunkIterator read(ReadOptions options);
    <T> JsonIterator<T> readJson(Class<T> type);
    <T> JsonIterator<T> readJson(TypeReference<T> type);

    // --- Read (Single response) ---
    StreamResponse readOnce();
    StreamResponse readOnce(ReadOptions options);
    CompletableFuture<StreamResponse> readOnceAsync();

    // --- Delete ---
    void delete();
    CompletableFuture<Void> deleteAsync();
}
```

### 4.4 Read Options (Like Kafka ConsumerConfig)

```java
public final class ReadOptions {

    public static ReadOptions defaults();
    public static Builder builder();

    public static final class Builder {
        public Builder offset(Offset offset);
        public Builder offset(String offset);
        public Builder fromBeginning();           // offset = -1
        public Builder fromNow();                 // offset = now

        public Builder live(LiveMode mode);       // OFF, LONG_POLL, SSE, AUTO
        public Builder longPoll();                // Convenience
        public Builder sse();                     // Convenience

        public Builder timeout(Duration timeout);
        public Builder cursor(String cursor);     // CDN collapsing

        public ReadOptions build();
    }
}

public enum LiveMode {
    OFF,        // Catch-up only, stop at end
    LONG_POLL,  // HTTP long-polling
    SSE,        // Server-Sent Events
    AUTO        // Library chooses based on context
}
```

### 4.5 Iterators (Inspired by Kafka's ConsumerRecords)

```java
public interface ChunkIterator extends Iterator<Chunk>, AutoCloseable {

    // Current position
    Offset currentOffset();
    boolean isUpToDate();

    // Timeout-aware iteration (like Kafka's poll)
    Optional<Chunk> poll(Duration timeout);

    // Batch operations
    List<Chunk> pollBatch(Duration timeout, int maxMessages);

    // Stream support (Java 8+)
    Stream<Chunk> stream();

    @Override
    void close();
}

public interface JsonIterator<T> extends Iterator<JsonBatch<T>>, AutoCloseable {

    // Flatten to individual items
    Iterator<T> items();
    Stream<T> itemStream();

    // Batch-aware iteration
    Optional<JsonBatch<T>> poll(Duration timeout);

    // Position tracking
    Offset currentOffset();
    boolean isUpToDate();

    @Override
    void close();
}
```

### 4.6 Model Classes

```java
public record Offset(String value) implements Comparable<Offset> {
    public static final Offset BEGINNING = new Offset("-1");
    public static final Offset NOW = new Offset("now");

    public static Offset of(String value);

    @Override
    public int compareTo(Offset other) {
        return this.value.compareTo(other.value);  // Lexicographic
    }
}

public record Chunk(
    byte[] data,
    Offset nextOffset,
    boolean upToDate,
    Optional<String> cursor,
    Map<String, String> headers
) {}

public record JsonBatch<T>(
    List<T> items,
    Offset nextOffset,
    boolean upToDate,
    Optional<String> cursor
) implements Iterable<T> {
    @Override
    public Iterator<T> iterator() {
        return items.iterator();
    }
}

public record AppendResult(
    Offset nextOffset,
    boolean duplicate  // True if idempotent duplicate detected
) {}

public record StreamMetadata(
    String contentType,
    Offset nextOffset,
    Optional<Duration> ttl,
    Optional<Instant> expiresAt
) {}
```

---

## 5. Configuration

### 5.1 BackoffConfig (Like Kafka's retry settings)

```java
public final class BackoffConfig {

    public static BackoffConfig defaults();  // 100ms initial, 60s max, 1.3x multiplier
    public static Builder builder();

    public Duration initialDelay();
    public Duration maxDelay();
    public double multiplier();
    public int maxRetries();          // -1 for infinite
    public Set<Integer> retryableStatuses();  // Default: 429, 5xx

    public static final class Builder {
        public Builder initialDelay(Duration delay);
        public Builder maxDelay(Duration delay);
        public Builder multiplier(double multiplier);
        public Builder maxRetries(int retries);
        public Builder retryOn(int... statuses);
        public BackoffConfig build();
    }
}
```

### 5.2 BatchConfig (Like Kafka/Pub/Sub batching)

```java
public final class BatchConfig {

    public static BatchConfig defaults();  // 1MB or 5ms linger
    public static BatchConfig disabled();
    public static Builder builder();

    public int maxBatchBytes();
    public int maxBatchMessages();
    public Duration lingerTime();
    public int maxInFlight();  // Pipelining

    public static final class Builder {
        public Builder maxBatchBytes(int bytes);
        public Builder maxBatchMessages(int count);
        public Builder lingerTime(Duration linger);
        public Builder maxInFlight(int count);
        public BatchConfig build();
    }
}
```

---

## 6. Error Handling

### 6.1 Exception Hierarchy (Like AWS SDK)

```java
public class DurableStreamException extends RuntimeException {
    public Optional<Integer> statusCode();
    public Optional<String> errorCode();
    public Map<String, String> responseHeaders();
}

// Client errors (4xx) - typically non-retryable
public class StreamNotFoundException extends DurableStreamException {}      // 404
public class StreamConflictException extends DurableStreamException {}      // 409 (exists with different config)
public class SequenceConflictException extends DurableStreamException {     // 409 (Stream-Seq regression)
    public String expectedSeq();
    public String receivedSeq();
}
public class StaleEpochException extends DurableStreamException {           // 403 (zombie fencing)
    public long currentEpoch();
}
public class OffsetGoneException extends DurableStreamException {}          // 410 (retention)
public class ContentTypeMismatchException extends DurableStreamException {} // 409

// Retryable errors
public class RateLimitedException extends DurableStreamException {          // 429
    public Optional<Duration> retryAfter();
}
public class ServerException extends DurableStreamException {}              // 5xx
```

### 6.2 Error Handler (Like existing TypeScript/Python clients)

```java
@FunctionalInterface
public interface ErrorHandler {
    /**
     * Handle an error during streaming.
     *
     * @return ErrorAction.RETRY to retry with optional modified headers,
     *         ErrorAction.STOP to stop the stream,
     *         ErrorAction.SKIP to skip this chunk and continue
     */
    ErrorAction handle(DurableStreamException error, ErrorContext context);
}

public sealed interface ErrorAction {
    record Retry(Map<String, String> additionalHeaders) implements ErrorAction {
        public static Retry withHeaders(Map<String, String> headers) { ... }
        public static Retry unchanged() { return new Retry(Map.of()); }
    }
    record Stop() implements ErrorAction {}
    record Skip() implements ErrorAction {}
}

public record ErrorContext(
    URI url,
    Offset currentOffset,
    int attemptNumber,
    Duration totalElapsed
) {}
```

---

## 7. Streaming Modes

### 7.1 Catch-Up Mode (Default)

```java
// Reads all available data, then stops when up-to-date
var handle = DurableStream.connect(url);
for (var chunk : handle.read()) {
    process(chunk);
    // Automatically stops when chunk.upToDate() == true
}
```

### 7.2 Long-Poll Mode (Like Kafka's poll loop)

```java
// Continuous polling with server-side waiting
var options = ReadOptions.builder()
    .fromBeginning()
    .longPoll()
    .build();

try (var iterator = handle.read(options)) {
    while (true) {
        var chunk = iterator.poll(Duration.ofSeconds(30));
        chunk.ifPresent(this::process);
    }
}
```

### 7.3 SSE Mode (Real-time streaming)

```java
// Server-Sent Events for real-time updates
var options = ReadOptions.builder()
    .fromNow()  // Only future events
    .sse()
    .build();

try (var iterator = handle.read(options)) {
    for (var chunk : (Iterable<Chunk>) () -> iterator) {
        process(chunk);
    }
}
```

### 7.4 Consumer Pattern (Like Pub/Sub's MessageReceiver)

For callback-based consumption:

```java
public interface StreamConsumer extends AutoCloseable {
    void start();
    void pause();
    void resume();
    boolean isRunning();
}

// Usage
var consumer = client.newConsumer(url)
    .offset(Offset.BEGINNING)
    .live(LiveMode.SSE)
    .handler(chunk -> {
        process(chunk);
        // Return true to continue, false to stop
        return true;
    })
    .errorHandler((error, ctx) -> ErrorAction.Retry.unchanged())
    .build();

consumer.start();
// ... later
consumer.close();
```

---

## 8. Idempotent Producer

### 8.1 Design (Kafka-style with Durable Streams protocol)

```java
public interface IdempotentProducer extends AutoCloseable {

    /**
     * Append data asynchronously. Returns immediately.
     * Data is batched and sent according to BatchConfig.
     */
    CompletableFuture<AppendResult> append(byte[] data);
    CompletableFuture<AppendResult> append(String data);
    <T> CompletableFuture<AppendResult> append(T data);

    /**
     * Append multiple items as a batch (JSON arrays flattened).
     */
    <T> CompletableFuture<AppendResult> appendAll(List<T> items);

    /**
     * Wait for all pending appends to complete.
     */
    void flush() throws DurableStreamException;
    CompletableFuture<Void> flushAsync();

    /**
     * Current producer state.
     */
    String producerId();
    long currentEpoch();
    long currentSeq();

    @Override
    void close() throws DurableStreamException;
}
```

### 8.2 Producer Builder

```java
public final class ProducerBuilder {

    // Identity
    public ProducerBuilder producerId(String id);
    public ProducerBuilder epoch(long epoch);
    public ProducerBuilder startingSeq(long seq);

    // Batching
    public ProducerBuilder batchConfig(BatchConfig config);
    public ProducerBuilder maxBatchBytes(int bytes);
    public ProducerBuilder lingerTime(Duration linger);
    public ProducerBuilder maxInFlight(int count);

    // Error handling
    public ProducerBuilder onError(ProducerErrorHandler handler);

    public IdempotentProducer build();
}

@FunctionalInterface
public interface ProducerErrorHandler {
    /**
     * Called when a batch fails after all retries exhausted.
     */
    void onBatchFailed(List<PendingAppend> failed, DurableStreamException cause);
}
```

### 8.3 Epoch Management

```java
// Explicit epoch management for advanced use cases
var producer = client.newProducer(url)
    .producerId("order-service-1")
    .epoch(0)  // First run
    .build();

// On restart, increment epoch
var producer = client.newProducer(url)
    .producerId("order-service-1")
    .epoch(1)  // Restart - fences out zombies
    .build();

// Or use auto-claim (for serverless/ephemeral)
var producer = client.newProducer(url)
    .producerId("lambda-function")
    .autoClaimOnStaleEpoch(true)  // Will retry with current+1 on 403
    .build();
```

---

## 9. JSON Support

### 9.1 Type-Safe JSON Iteration (Like Pulsar's schema support)

```java
// With explicit type
record Event(String type, Map<String, Object> data) {}

try (var iterator = handle.readJson(Event.class)) {
    for (var batch : (Iterable<JsonBatch<Event>>) () -> iterator) {
        for (Event event : batch) {
            process(event);
        }
    }
}

// With generic types using TypeReference
try (var iterator = handle.readJson(new TypeReference<Map<String, Object>>() {})) {
    for (var item : iterator.itemStream().toList()) {
        // item is Map<String, Object>
    }
}
```

### 9.2 JSON Append with Automatic Wrapping

```java
// Single object - wrapped in array for protocol compliance
producer.append(new Event("created", data));
// Sent as: [{"type":"created","data":{...}}]
// Server stores: {"type":"created","data":{...}}

// Multiple objects - sent as array, flattened by server
producer.appendAll(List.of(event1, event2, event3));
// Sent as: [event1, event2, event3]
// Server stores: event1, event2, event3 (as separate messages)
```

---

## 10. Threading Model

### 10.1 Thread Safety Guarantees

| Component | Thread Safety | Notes |
|-----------|--------------|-------|
| `DurableStream` | Thread-safe | Shared client instance |
| `StreamHandle` | Thread-safe | Can be shared, each op is independent |
| `ChunkIterator` | NOT thread-safe | Single consumer per iterator |
| `JsonIterator` | NOT thread-safe | Single consumer per iterator |
| `IdempotentProducer` | Thread-safe | Concurrent `append()` supported |
| `StreamConsumer` | Thread-safe | Lifecycle methods safe from any thread |

### 10.2 Executor Configuration

```java
var client = DurableStream.builder()
    .url(baseUrl)
    // Async operations executor (default: ForkJoinPool.commonPool())
    .executor(Executors.newFixedThreadPool(10))
    // Consumer callback executor (default: single-threaded per consumer)
    .consumerExecutor(Executors.newCachedThreadPool())
    .build();
```

---

## 11. Resource Management

### 11.1 AutoCloseable Pattern (Universal)

```java
// Try-with-resources (recommended)
try (var client = DurableStream.builder().build();
     var iterator = client.stream(url).read()) {
    for (var chunk : (Iterable<Chunk>) () -> iterator) {
        process(chunk);
    }
}

// Manual management
var client = DurableStream.builder().build();
try {
    // ... operations
} finally {
    client.close();
}
```

### 11.2 Graceful Shutdown

```java
// Producer: flush pending before close
try (var producer = client.newProducer(url).build()) {
    producer.append(data1);
    producer.append(data2);
    // close() implicitly calls flush()
}

// Consumer: stop receiving, finish processing current
consumer.close();  // Waits for current handler to complete
consumer.closeNow(); // Interrupts immediately
```

---

## 12. Examples

### 12.1 Simple Read (Catch-up)

```java
import com.durablestreams.*;

public class SimpleRead {
    public static void main(String[] args) {
        var url = "https://api.example.com/streams/events";

        for (var chunk : DurableStream.connect(url).read()) {
            System.out.println("Received: " + new String(chunk.data()));
            System.out.println("Next offset: " + chunk.nextOffset());
        }

        System.out.println("Caught up with stream!");
    }
}
```

### 12.2 Live Tailing with JSON

```java
import com.durablestreams.*;

public class LiveTailing {

    record ChatMessage(String user, String text, Instant timestamp) {}

    public static void main(String[] args) throws Exception {
        var client = DurableStream.builder()
            .bearerToken(System.getenv("API_TOKEN"))
            .build();

        var options = ReadOptions.builder()
            .fromNow()
            .sse()
            .build();

        try (var iterator = client.stream(CHAT_URL).readJson(ChatMessage.class, options)) {
            for (var message : iterator.itemStream().toList()) {
                System.out.printf("[%s] %s: %s%n",
                    message.timestamp(), message.user(), message.text());
            }
        }
    }
}
```

### 12.3 Idempotent Producer

```java
import com.durablestreams.*;
import com.durablestreams.producer.*;

public class ReliableProducer {

    public static void main(String[] args) throws Exception {
        var client = DurableStream.builder()
            .bearerToken(System.getenv("API_TOKEN"))
            .build();

        try (var producer = client.newProducer(ORDERS_URL)
                .producerId("order-service-" + getInstanceId())
                .epoch(getEpochFromStorage())
                .maxBatchBytes(1024 * 1024)  // 1MB batches
                .lingerTime(Duration.ofMillis(5))
                .maxInFlight(5)
                .onError((failed, cause) -> {
                    log.error("Batch failed: {}", failed.size(), cause);
                    alertOps(failed, cause);
                })
                .build()) {

            // Fire-and-forget appends
            for (Order order : orderStream()) {
                producer.append(order);
            }

            // Ensure everything sent before shutdown
            producer.flush();
        }
    }
}
```

### 12.4 Consumer with Error Recovery

```java
import com.durablestreams.*;
import com.durablestreams.consumer.*;

public class ResilientConsumer {

    public static void main(String[] args) {
        var offsetStore = new RedisOffsetStore(redisClient);

        var consumer = client.newConsumer(EVENTS_URL)
            .offset(offsetStore.get(EVENTS_URL).orElse(Offset.BEGINNING))
            .live(LiveMode.LONG_POLL)
            .handler(chunk -> {
                processEvents(chunk);
                offsetStore.save(EVENTS_URL, chunk.nextOffset());
                return true;  // Continue
            })
            .errorHandler((error, ctx) -> {
                if (error instanceof RateLimitedException rle) {
                    log.warn("Rate limited, backing off");
                    return ErrorAction.Retry.unchanged();
                }
                if (error.statusCode().orElse(0) == 401) {
                    return ErrorAction.Retry.withHeaders(Map.of(
                        "Authorization", "Bearer " + refreshToken()
                    ));
                }
                log.error("Unrecoverable error", error);
                return ErrorAction.Stop();
            })
            .build();

        Runtime.getRuntime().addShutdownHook(new Thread(consumer::close));
        consumer.start();
    }
}
```

### 12.5 Reactive Streams Integration (Optional Module)

```java
// com.durablestreams:durable-streams-reactor module
import com.durablestreams.reactor.*;
import reactor.core.publisher.Flux;

Flux<Event> events = ReactorDurableStream.from(client.stream(url))
    .readJson(Event.class)
    .flatMapIterable(JsonBatch::items)
    .filter(e -> e.type().equals("order_created"))
    .take(Duration.ofMinutes(5));

events.subscribe(this::process);
```

---

## 13. Future Considerations

### 13.1 Potential Enhancements

1. **Virtual Threads (Java 21+)**: Leverage Project Loom for simplified async
2. **GraalVM Native Image**: AOT compilation support
3. **Reactive Streams Module**: Reactor/RxJava integration
4. **Micrometer Metrics**: Built-in observability
5. **OpenTelemetry Tracing**: Distributed tracing support
6. **Kotlin Extensions**: Coroutine-friendly API
7. **Spring Boot Starter**: Auto-configuration module

### 13.2 Protocol Extensions

1. **Compression**: gzip/zstd support for large payloads
2. **Partitioning**: Multiple streams as logical partition
3. **Transactions**: Atomic multi-stream operations

### 13.3 Java Version Support

| Java Version | Support Level |
|--------------|---------------|
| Java 11 | Full support (minimum requirement) |
| Java 17 | Full support (LTS recommended) |
| Java 21 | Full support + Virtual Threads |

---

## Appendix A: Comparison with Other Clients

| Feature | TypeScript | Python | Go | Java (Proposed) |
|---------|-----------|--------|-----|-----------------|
| Sync API | - | ✓ | ✓ | ✓ |
| Async API | ✓ | ✓ | ✓ | ✓ |
| Reactive API | - | - | - | ✓ (module) |
| Type-safe JSON | ✓ | ✓ | ✓ | ✓ |
| Builder pattern | - | - | ✓ | ✓ |
| Idempotent producer | ✓ | ✓ | ✓ | ✓ |
| Error handlers | ✓ | ✓ | - | ✓ |
| SSE resilience | ✓ | - | - | ✓ |

## Appendix B: Dependencies

### Required
- Java 11+
- `java.net.http.HttpClient` (JDK built-in)

### Optional
- Jackson (`com.fasterxml.jackson`) - JSON support
- SLF4J - Logging facade

### Modules (separate artifacts)
- `durable-streams-reactor` - Reactor integration
- `durable-streams-rxjava` - RxJava integration
- `durable-streams-spring` - Spring Boot starter
- `durable-streams-micrometer` - Metrics

---

## References

### Protocol
- [Durable Streams Protocol Specification](../../PROTOCOL.md)

### Research Sources
- [Apache Kafka Java Client](https://docs.confluent.io/kafka-clients/java/current/overview.html)
- [Apache Pulsar Java Client](https://pulsar.apache.org/docs/next/client-libraries-java/)
- [AWS Kinesis SDK for Java](https://docs.aws.amazon.com/sdk-for-java/latest/developer-guide/examples-kinesis.html)
- [Google Cloud Pub/Sub Java Client](https://cloud.google.com/java/docs/reference/google-cloud-pubsub/latest/overview)
- [Azure Event Hubs Java Client](https://learn.microsoft.com/en-us/java/api/overview/azure/messaging-eventhubs-readme)
- [NATS JetStream Java Client](https://github.com/nats-io/nats.java)
- [RabbitMQ Stream Java Client](https://rabbitmq.github.io/rabbitmq-stream-java-client/stable/htmlsingle/)
- [Redis Lettuce Java Client](https://redis.io/docs/latest/develop/clients/jedis/)
- [Apache Flink DataStream API](https://nightlies.apache.org/flink/flink-docs-master/docs/dev/datastream/overview/)
- [Redpanda Kafka Compatibility](https://docs.redpanda.com/current/develop/kafka-clients/)
