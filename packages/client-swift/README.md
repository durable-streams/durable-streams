# DurableStreams Swift Client

A native Swift client for [Durable Streams](https://github.com/durable-streams/durable-streams) — the open protocol for real-time sync to client applications.

**Durable Streams** provides HTTP-based durable streams for streaming data reliably to iOS apps, macOS applications, and Swift servers with offset-based resumability. Think "append-only log as a service" with exactly-once semantics.

## Why Durable Streams?

Modern apps need ordered, replayable data streams that survive disconnections:

- **AI conversation streaming** — Resume LLM token streams after tab suspension or network flaps
- **Real-time sync** — Stream database changes to mobile apps with guaranteed delivery
- **Collaborative apps** — Sync CRDTs across devices without missing updates
- **Event sourcing** — Build event-sourced architectures with client-side replay

The protocol is refresh-safe, multi-device, and CDN-friendly — one origin can serve millions of concurrent viewers.

## Requirements

- Swift 6.0+
- macOS 13+ / iOS 16+ / tvOS 16+ / watchOS 9+ / Linux

## Installation

### Swift Package Manager

```swift
dependencies: [
    .package(url: "https://github.com/durable-streams/durable-streams", from: "0.1.0")
]
```

```swift
.target(
    name: "YourApp",
    dependencies: [
        .product(name: "DurableStreams", package: "durable-streams")
    ]
)
```

## Quick Start

### Stream Messages in Real-Time

```swift
import DurableStreams

let handle = try await DurableStream.connect(
    url: URL(string: "https://api.example.com/streams/events")!
)

// Stream messages as they arrive
for try await event in handle.messages(as: AppEvent.self) {
    switch event.type {
    case "user.created":
        await handleUserCreated(event)
    case "order.placed":
        await handleOrder(event)
    default:
        break
    }
}
```

### Resume from Last Position

```swift
// Offset is Codable — save and restore with JSONEncoder/Decoder
func loadOffset() -> Offset {
    guard let data = UserDefaults.standard.data(forKey: "stream.offset"),
          let offset = try? JSONDecoder().decode(Offset.self, from: data) else {
        return .start
    }
    return offset
}

func saveOffset(_ offset: Offset) {
    if let data = try? JSONEncoder().encode(offset) {
        UserDefaults.standard.set(data, forKey: "stream.offset")
    }
}

// Stream with per-batch checkpointing
for try await batch in handle.jsonBatches(as: AppEvent.self, from: loadOffset()) {
    for event in batch.items {
        try await processEvent(event)
    }
    saveOffset(batch.offset)  // Checkpoint after each batch
}
```

### High-Throughput Writes

```swift
let stream = try await DurableStream.create(
    url: URL(string: "https://api.example.com/streams/telemetry")!,
    contentType: "application/json"
)

// IdempotentProducer for fire-and-forget writes with exactly-once delivery
let producer = IdempotentProducer(
    stream: stream,
    producerId: "device-\(deviceId)",
    config: .init(
        autoClaim: true,  // Auto-recover from epoch conflicts
        onError: { error in
            logger.error("Batch failed: \(error)")
        }
    )
)

// Fire-and-forget — automatically batched and pipelined
for measurement in sensorReadings {
    producer.append(measurement)  // Returns immediately
}

// Ensure delivery before app termination
try await producer.flush()
```

## Core Concepts

### Offsets

Offsets are opaque tokens identifying positions in a stream. Never parse them — just store and pass them back.

```swift
// Special values
let fromBeginning = Offset.start  // "-1"
let fromNow = Offset.now          // Current tail

// From a previous read
let resumed = Offset(rawValue: savedOffsetString)

// Offsets are Comparable
if batch.offset > lastProcessedOffset {
    // New data
}
```

### Live Modes

```swift
// Catch-up: Read existing data, return immediately at end
for try await batch in handle.jsonBatches(as: Event.self, from: .start) {
    // Processes all historical data, then completes
}

// Long-poll: Wait for new data (HTTP long-polling)
for try await message in handle.messages(as: Event.self, from: lastOffset) {
    // Blocks until new data arrives, perfect for real-time updates
}

// SSE: Server-Sent Events for persistent connections
for try await event in handle.sseEvents(from: lastOffset) {
    print("Event type: \(event.effectiveEvent), data: \(event.data)")
}
```

## API Reference

### Reading Streams

#### Simple Read (One-Shot)

```swift
// Read-only stream function
let response = try await stream(
    url: URL(string: "https://api.example.com/streams/events")!,
    offset: .start,
    live: .catchUp
)

let messages = try response.json(as: Message.self)
print("Got \(messages.items.count) messages, next offset: \(messages.offset)")
```

#### Streaming with AsyncSequence

```swift
let handle = try await DurableStream.connect(url: streamURL)

// Stream individual messages (flattens batches)
for try await message in handle.messages(as: ChatMessage.self) {
    displayMessage(message)
}

// Stream batches for checkpointing
for try await batch in handle.jsonBatches(as: Event.self, from: savedOffset) {
    try await db.transaction { tx in
        for event in batch.items {
            try await tx.apply(event)
        }
        try await tx.saveOffset(batch.offset)
    }
}

// Stream raw bytes
for try await chunk in handle.byteChunks() {
    processData(chunk.data)
}

// Stream text
for try await chunk in handle.textChunks() {
    appendToLog(chunk.text)
}
```

### Writing Streams

#### Synchronous Writes

```swift
let handle = try await DurableStream.create(
    url: streamURL,
    contentType: "application/json"
)

// Append and wait for acknowledgment
let result = try await handle.appendSync(MyEvent(type: "click", elementId: "buy-btn"))
print("Written at offset: \(result.offset)")
```

#### Fire-and-Forget with IdempotentProducer

```swift
let producer = IdempotentProducer(
    stream: handle,
    producerId: "worker-1",
    epoch: 0,
    config: .init(
        autoClaim: true,           // Auto-bump epoch on conflicts
        maxBatchBytes: 1_048_576,  // 1MB batches
        lingerMs: 5,               // Wait 5ms to collect more items
        maxInFlight: 5,            // Pipeline up to 5 batches
        onError: { error in
            // Handle batch failures (network errors, etc.)
        }
    )
)

// These return immediately
producer.append(event1)
producer.append(event2)
producer.append(event3)

// Wait for all to be acknowledged
let result = try await producer.flush()
print("Flushed \(result.duplicateCount) duplicates, final offset: \(result.offset)")
```

### Stream Lifecycle

```swift
// Create a new stream
let handle = try await DurableStream.create(
    url: streamURL,
    contentType: "application/json",
    ttlSeconds: 86400  // Auto-delete after 24 hours
)

// Connect to existing stream
let handle = try await DurableStream.connect(url: streamURL)

// Create if not exists, connect if it does
let handle = try await DurableStream.createOrConnect(url: streamURL)

// Get stream metadata
let info = try await DurableStream.head(url: streamURL)
print("Content-Type: \(info.contentType ?? "unknown")")

// Delete a stream
try await DurableStream.delete(url: streamURL)
```

## Configuration

### Unified HandleConfiguration

```swift
let config = HandleConfiguration(
    idempotentProducer: .enabled(
        producerId: "my-producer",
        autoClaimOnStaleEpoch: true
    ),
    batching: .highThroughput,  // Or .lowLatency, .default, .disabled
    http: .init(timeout: 30, longPollTimeout: 60),
    retry: .aggressive,
    headers: ["Authorization": .provider { await getToken() }]
)

let handle = try await DurableStream.create(
    url: streamURL,
    contentType: "application/json",
    handleConfig: config
)
```

### Batching Presets

```swift
// Default: 1MB batches, 5ms linger, 5 in-flight
BatchingConfig.default

// High throughput: 4MB batches, 20ms linger, 10 in-flight
BatchingConfig.highThroughput

// Low latency: 64KB batches, 1ms linger
BatchingConfig.lowLatency

// No batching
BatchingConfig.disabled

// Custom with Swift Duration (Swift-native convenience API)
BatchingConfig(maxBytes: 512_000, linger: .milliseconds(10))
```

### Retry Configuration

```swift
// Default retry policy
RetryConfig.default

// Aggressive retries
RetryConfig.aggressive

// Custom with Swift Duration
let retry = RetryConfig(
    maxAttempts: 5,
    baseDelay: .milliseconds(100),
    maxDelay: .seconds(10),
    jitterFactor: 0.2
)
```

### Dynamic Headers

Perfect for auth token refresh:

```swift
let handle = try await DurableStream.connect(
    url: streamURL,
    config: .init(headers: [
        "Authorization": .provider {
            await authManager.getValidToken()
        }
    ])
)
```

## iOS App Lifecycle

### Suspend and Resume

```swift
class StreamManager: ObservableObject {
    let lifecycleManager = StreamLifecycleManager()
    private var handle: DurableStream?

    func connect() async throws {
        handle = try await DurableStream.connect(url: streamURL)
    }

    func suspend() async {
        guard let handle = handle else { return }
        await lifecycleManager.suspend(handle)
    }

    func resume() async throws {
        handle = try await lifecycleManager.resume(for: streamURL)
    }
}
```

### SwiftUI Integration

```swift
struct ContentView: View {
    @StateObject private var streamState = StreamState()

    var body: some View {
        MessageList()
            .onReceive(NotificationCenter.default.publisher(
                for: UIApplication.willResignActiveNotification
            )) { _ in
                Task { await streamState.suspend() }
            }
            .onReceive(NotificationCenter.default.publisher(
                for: UIApplication.didBecomeActiveNotification
            )) { _ in
                Task { await streamState.resume() }
            }
    }
}
```

### Background Flush

Ensure pending writes are delivered before app suspension:

```swift
func applicationDidEnterBackground() {
    Task {
        try await handle.requestBackgroundFlush()
    }
}
```

## Error Handling

```swift
do {
    let handle = try await DurableStream.connect(url: url)
} catch let error as DurableStreamError {
    switch error.code {
    case .notFound:
        // Stream doesn't exist — create it or show error
        break
    case .unauthorized:
        // Refresh auth token and retry
        break
    case .staleEpoch:
        // Another producer claimed the epoch — let it handle writes
        if let details = error.details,
           let currentEpoch = details["currentEpoch"].flatMap(Int.init) {
            print("Current epoch: \(currentEpoch)")
        }
    case .retentionExpired:
        // Data at offset was garbage collected — restart from .start or .now
        break
    case .networkError:
        // Retry with exponential backoff
        break
    default:
        print("[\(error.code)] \(error.message)")
    }
}
```

## Server-Side Swift

For Vapor, Hummingbird, or other Swift servers:

```swift
// ServiceLifecycle integration (when available)
import ServiceLifecycle

let handle = try await DurableStream.create(url: streamURL)
let producer = IdempotentProducer(stream: handle, producerId: "server-1")

// Both conform to Service protocol for graceful shutdown
let serviceGroup = ServiceGroup(
    services: [handle, producer],
    gracefulShutdownSignals: [.sigterm, .sigint]
)

try await serviceGroup.run()
```

## Protocol Compatibility

This client implements the full [Durable Streams protocol](https://github.com/durable-streams/durable-streams/blob/main/PROTOCOL.md):

- **178/178** conformance tests passing
- Offset-based resumption
- Long-poll and SSE live modes
- Idempotent producers with epoch/sequence management
- JSON mode with automatic array handling
- Dynamic headers and query parameters

## License

MIT — see [LICENSE](../../LICENSE)

## Links

- [Durable Streams Protocol](https://github.com/durable-streams/durable-streams)
- [Protocol Specification](https://github.com/durable-streams/durable-streams/blob/main/PROTOCOL.md)
- [Design Document](./design.md)
