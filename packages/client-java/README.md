# Durable Streams Java Client

Java client library for the [Durable Streams](https://github.com/durable-streams/durable-streams) protocol - HTTP-based durable streams for reliably streaming data to applications with offset-based resumability.

## What is Durable Streams?

Modern applications need ordered, durable sequences of data that can be replayed from any point and tailed in real time. Common use cases include:

- **AI conversation streaming** - Stream LLM tokens with resume capability across reconnections
- **Database synchronization** - Stream changes to clients with guaranteed delivery
- **Event sourcing** - Build event-sourced systems with client-side replay
- **Real-time updates** - Push state changes with exactly-once semantics

Durable Streams provides this as a simple HTTP-based protocol. When a tab gets suspended, networks flap, or pages refresh, clients pick up exactly where they left off.

## Features

- **Zero dependencies** - Uses only JDK 11+ APIs
- **Sync and async APIs** - `CompletableFuture` variants for all operations
- **Type-safe JSON** - Generic `JsonIterator<T>` with your choice of JSON library
- **Exactly-once writes** - `IdempotentProducer` with batching and epoch-based fencing
- **Automatic retry** - Exponential backoff for transient failures
- **Iterator-based reads** - Natural for-each loops with `AutoCloseable`

## Installation

### Gradle

```kotlin
dependencies {
    implementation("com.durablestreams:durable-streams:0.1.0")
}
```

### Maven

```xml
<dependency>
    <groupId>com.durablestreams</groupId>
    <artifactId>durable-streams</artifactId>
    <version>0.1.0</version>
</dependency>
```

## Quick Start

### Create and Write to a Stream

```java
import com.durablestreams.*;

var client = DurableStream.create();
String url = "https://your-server.com/streams/events";

// Create a JSON stream
client.create(url, "application/json");

// Append data
client.append(url, "{\"event\":\"user.created\",\"userId\":\"123\"}".getBytes());
```

### Read from a Stream

```java
// Read all data (catch-up mode)
try (var chunks = client.read(url)) {
    for (var chunk : chunks) {
        System.out.println(chunk.getDataAsString());
        // Save chunk.getNextOffset() for resumption
    }
}
```

### Resume from an Offset

```java
import com.durablestreams.model.ReadOptions;

// Resume from where you left off
var savedOffset = Offset.of("abc123xyz");

try (var chunks = client.read(url, ReadOptions.from(savedOffset))) {
    for (var chunk : chunks) {
        process(chunk);
    }
}
```

### Live Tailing

```java
import com.durablestreams.model.LiveMode;
import com.durablestreams.model.ReadOptions;

// Long-poll mode - server holds connection until data arrives
try (var chunks = client.read(url, ReadOptions.from(offset).live(LiveMode.LONG_POLL))) {
    while (true) {
        var chunk = chunks.poll(Duration.ofSeconds(30));
        if (chunk != null) {
            process(chunk);
        }
    }
}

// SSE mode - continuous streaming
try (var chunks = client.read(url, ReadOptions.from(offset).live(LiveMode.SSE))) {
    for (var chunk : chunks) {
        process(chunk);  // Chunks arrive as data is appended
    }
}
```

## Type-Safe JSON

The `JsonIterator<T>` provides type-safe iteration over JSON streams. You provide the parser function, so you can use any JSON library (Gson, Jackson, etc.) without adding dependencies to the core library.

### With Gson

```java
import com.google.gson.Gson;
import com.google.gson.reflect.TypeToken;

record Event(String type, String userId) {}

Gson gson = new Gson();
Type listType = new TypeToken<List<Event>>(){}.getType();

try (var iter = client.readJson(url, json -> gson.fromJson(json, listType))) {
    // Iterate individual items (flattens batches)
    for (Event event : iter.items()) {
        System.out.printf("Event: %s for user %s%n", event.type(), event.userId());
    }
}
```

### With Jackson

```java
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.JavaType;

ObjectMapper mapper = new ObjectMapper();
JavaType listType = mapper.getTypeFactory()
    .constructCollectionType(List.class, Event.class);

try (var iter = client.readJson(url, json -> mapper.readValue(json, listType))) {
    // Use Java Streams
    iter.itemStream()
        .filter(e -> e.type().equals("user.created"))
        .forEach(this::handleUserCreated);
}
```

### Batch Iteration

```java
// Iterate batches (preserves server response boundaries)
try (var iter = client.readJson(url, parser)) {
    for (JsonBatch<Event> batch : iter) {
        System.out.printf("Batch of %d items, upToDate=%s%n",
            batch.size(), batch.isUpToDate());
        for (Event event : batch) {
            process(event);
        }
    }
}
```

## Idempotent Producer

For high-throughput exactly-once writes, use `IdempotentProducer`. It batches appends, handles retries, and uses epoch-based fencing to prevent duplicates.

### Basic Usage

```java
try (var producer = client.producer(url, "my-producer")) {
    // Fire-and-forget - calls return immediately
    producer.append("{\"event\":\"a\"}");
    producer.append("{\"event\":\"b\"}");
    producer.append("{\"event\":\"c\"}");

    // Wait for all pending batches to complete
    producer.flush();
}  // close() calls flush() automatically
```

### Configuration

```java
var config = IdempotentProducer.Config.builder()
    .epoch(0)                    // Starting epoch (increment on restart)
    .startingSeq(0)              // Starting sequence number
    .autoClaim(true)             // Auto-recover from epoch conflicts
    .maxBatchBytes(1024 * 1024)  // 1MB max batch size
    .lingerMs(5)                 // Wait 5ms to accumulate batch
    .maxInFlight(5)              // Max concurrent HTTP requests
    .onError(e -> log.error("Batch failed", e))
    .build();

var producer = client.producer(url, "order-service", config);
```

### Epoch-Based Fencing

Epochs prevent "zombie" producers from causing duplicates after failover:

```java
// First deployment
var producer = client.producer(url, "worker-1",
    Config.builder().epoch(0).build());

// After restart - increment epoch to fence out old instance
var producer = client.producer(url, "worker-1",
    Config.builder().epoch(1).build());

// Or use autoClaim for serverless environments
var producer = client.producer(url, "lambda-handler",
    Config.builder().autoClaim(true).build());
```

## Async API

For high-throughput appends, use `appendAsync`:

```java
// Parallel appends across multiple streams
var urls = List.of(url1, url2, url3);
var futures = urls.stream()
    .map(u -> client.appendAsync(u, data))
    .toList();

CompletableFuture.allOf(futures.toArray(new CompletableFuture[0]))
    .thenRun(() -> log.info("All appends complete"));
```

## Error Handling

All exceptions extend `RuntimeException` (unchecked), so you don't need to declare them in method signatures. However, you should handle them appropriately:

```java
try {
    client.append(url, data);
} catch (StreamNotFoundException e) {
    // 404 - Stream doesn't exist
    client.create(url, "application/json");
    client.append(url, data);
} catch (SequenceConflictException e) {
    // 409 - Sequence number regression
    log.error("Conflict: expected {}, got {}",
        e.getExpectedSeq(), e.getReceivedSeq());
} catch (StaleEpochException e) {
    // 403 - Another producer claimed this epoch
    log.error("Fenced by epoch {}", e.getCurrentEpoch());
} catch (OffsetGoneException e) {
    // 410 - Offset was pruned (TTL expired)
    log.warn("Offset gone, starting from beginning");
} catch (DurableStreamException e) {
    // Other errors
    log.error("Status {}: {}", e.getStatusCode().orElse(-1), e.getMessage());
}
```

## Client Configuration

```java
var client = DurableStream.builder()
    // Custom HTTP client
    .httpClient(HttpClient.newBuilder()
        .connectTimeout(Duration.ofSeconds(10))
        .build())

    // Retry policy
    .retryPolicy(RetryPolicy.builder()
        .maxRetries(5)
        .initialDelay(Duration.ofMillis(100))
        .maxDelay(Duration.ofSeconds(30))
        .multiplier(2.0)
        .build())

    // Static headers
    .header("Authorization", "Bearer " + token)

    // Dynamic headers (called on each request)
    .header("X-Request-Id", () -> UUID.randomUUID().toString())

    // Query parameters
    .param("api_key", apiKey)

    .build();
```

## Thread Safety

| Component            | Thread Safety                          |
| -------------------- | -------------------------------------- |
| `DurableStream`      | Thread-safe (share across threads)     |
| `ChunkIterator`      | NOT thread-safe (single consumer)      |
| `JsonIterator`       | NOT thread-safe (single consumer)      |
| `IdempotentProducer` | Thread-safe (concurrent `append()` OK) |

## Complete Example: Event Processing

```java
import com.durablestreams.*;
import com.durablestreams.model.*;
import com.google.gson.Gson;
import com.google.gson.reflect.TypeToken;

public class EventProcessor {

    record Event(String type, String userId, Map<String, Object> data) {}

    private final DurableStream client;
    private final Gson gson = new Gson();
    private final Type listType = new TypeToken<List<Event>>(){}.getType();

    public EventProcessor() {
        this.client = DurableStream.builder()
            .header("Authorization", "Bearer " + System.getenv("API_TOKEN"))
            .build();
    }

    public void processEvents(String streamUrl, Offset startOffset) {
        var options = ReadOptions.from(startOffset)
            .live(LiveMode.LONG_POLL)
            .timeout(Duration.ofSeconds(30));

        try (var iter = client.readJson(streamUrl, json -> gson.fromJson(json, listType), options)) {
            for (Event event : iter.items()) {
                switch (event.type()) {
                    case "user.created" -> handleUserCreated(event);
                    case "user.updated" -> handleUserUpdated(event);
                    case "user.deleted" -> handleUserDeleted(event);
                    default -> log.warn("Unknown event type: {}", event.type());
                }

                // Checkpoint after each event
                saveOffset(iter.getCurrentOffset());
            }
        }
    }

    public void produceEvents(String streamUrl, List<Event> events) {
        var config = IdempotentProducer.Config.builder()
            .autoClaim(true)
            .lingerMs(10)
            .onError(e -> log.error("Failed to send batch", e))
            .build();

        try (var producer = client.producer(streamUrl, "event-producer", config)) {
            for (Event event : events) {
                producer.append(gson.toJson(event));
            }
        }
    }
}
```

## Protocol

The client implements the [Durable Streams Protocol](../../PROTOCOL.md). Key operations:

| Operation | Method                                       | Description           |
| --------- | -------------------------------------------- | --------------------- |
| Create    | `PUT /stream/{path}`                         | Create a new stream   |
| Append    | `POST /stream/{path}`                        | Append data to stream |
| Read      | `GET /stream/{path}?offset=X`                | Read from offset      |
| Live tail | `GET /stream/{path}?offset=X&live=long-poll` | Wait for new data     |
| Metadata  | `HEAD /stream/{path}`                        | Get stream info       |
| Delete    | `DELETE /stream/{path}`                      | Delete stream         |

## Requirements

- **Java 11+** (uses `java.net.http.HttpClient`)
- No external dependencies

## License

MIT - see [LICENSE](../../LICENSE)

## Links

- [Durable Streams](https://github.com/durable-streams/durable-streams) - Main repository
- [Protocol Specification](../../PROTOCOL.md) - HTTP protocol details
- [Design Document](./design.md) - API design decisions
