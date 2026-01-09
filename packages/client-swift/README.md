# DurableStreams Swift Client

A Swift client for the [Durable Streams](https://github.com/durable-streams/durable-streams) protocol.

## Requirements

- Swift 5.9+
- macOS 13+ / iOS 16+ / tvOS 16+ / watchOS 9+

## Installation

### Swift Package Manager

Add the following to your `Package.swift`:

```swift
dependencies: [
    .package(url: "https://github.com/durable-streams/durable-streams", from: "0.1.0")
]
```

Then add the dependency to your target:

```swift
.target(
    name: "YourTarget",
    dependencies: [
        .product(name: "DurableStreams", package: "durable-streams")
    ]
)
```

## Quick Start

### Reading from a Stream

```swift
import DurableStreams

// Simple read with the stream() function
let response = try await stream(
    url: URL(string: "https://your-server.com/v1/stream/my-stream")!,
    offset: .start
)

// Get JSON messages with resumption offset
let batch = try response.json(as: MyMessage.self)
for message in batch.items {
    print("Message: \(message)")
}
saveCheckpoint(batch.offset)  // Save for resumption
```

### Writing to a Stream

```swift
import DurableStreams

// Create a stream
let stream = try await DurableStream.create(
    url: URL(string: "https://your-server.com/v1/stream/my-stream")!,
    contentType: "application/json"
)

// Append data (awaits server acknowledgment)
let result = try await stream.appendSync(MyEvent(type: "user.created", userId: "123"))
print("Written at offset: \(result.offset)")
```

### High-Throughput Writes with IdempotentProducer

```swift
import DurableStreams

let stream = try await DurableStream.connect(
    url: URL(string: "https://your-server.com/v1/stream/my-stream")!
)

let producer = IdempotentProducer(
    stream: stream,
    producerId: "order-processor-1",
    config: .init(
        autoClaim: true,
        onError: { error in
            print("Batch failed: \(error)")
        }
    )
)

// Fire-and-forget appends (automatically batched)
await producer.append(OrderCreated(orderId: "123"))
await producer.append(OrderUpdated(orderId: "123", status: .processing))
await producer.append(OrderCompleted(orderId: "123"))

// Ensure all are persisted before shutdown
let result = try await producer.flush()
print("All data written up to: \(result.offset)")

try await producer.close()
```

## API Reference

### Stream Function (Read-Only)

The simplest way to read from a stream:

```swift
let response = try await stream(
    url: URL,
    offset: Offset = .start,
    live: LiveMode = .auto,
    headers: HeadersRecord = [:],
    params: ParamsRecord = [:]
)
```

### DurableStream (Read/Write Handle)

For full read/write access:

```swift
// Factory methods
let stream = try await DurableStream.create(url:contentType:)
let stream = try await DurableStream.connect(url:)
let stream = try await DurableStream.createOrConnect(url:contentType:)

// Reading
let result = try await stream.read(offset:live:)
let batch = try await stream.readJSON(as:offset:)
let text = try await stream.readText(offset:)

// Writing (synchronous - awaits acknowledgment)
let result = try await stream.appendSync(data)
let result = try await stream.appendSync(encodableValue)

// Metadata
let info = try await DurableStream.head(url:)

// Cleanup
try await DurableStream.delete(url:)
```

### IdempotentProducer (Fire-and-Forget)

For high-throughput writes with exactly-once semantics:

```swift
let producer = IdempotentProducer(
    stream: stream,
    producerId: "unique-producer-id",
    epoch: 0,
    config: .init(
        autoClaim: true,        // Auto-recover on epoch conflicts
        maxBatchBytes: 1_048_576, // 1MB max batch
        lingerMs: 5,            // Wait 5ms for batching
        maxInFlight: 5,         // Max concurrent batches
        onError: { error in }   // Error callback
    )
)

// These return immediately
await producer.append(value)
await producer.appendString(text)
await producer.appendData(data)

// Wait for all to be acknowledged
let result = try await producer.flush()
try await producer.close()
```

### Types

#### Offset

```swift
let offset = Offset.start       // "-1" - beginning of stream
let offset = Offset.now         // "now" - current tail
let offset = Offset(rawValue: "abc123")  // From previous read
```

#### LiveMode

```swift
.catchUp   // Read existing data, stop at end
.longPoll  // Long-poll for live updates
.sse       // Server-Sent Events (explicit opt-in)
.auto      // Auto-select based on context
```

### Dynamic Headers

Support per-request header evaluation for auth token refresh:

```swift
let response = try await stream(
    url: streamURL,
    headers: [
        "Authorization": .provider { await getToken() },
        "X-Request-Id": .provider { UUID().uuidString }
    ]
)
```

## Error Handling

All errors are thrown as `DurableStreamError`:

```swift
do {
    let stream = try await DurableStream.connect(url: url)
} catch let error as DurableStreamError {
    switch error.code {
    case .notFound:
        print("Stream doesn't exist")
    case .unauthorized:
        print("Auth required")
    case .staleEpoch:
        print("Producer epoch is stale")
    default:
        print("Error: \(error.message)")
    }
}
```

## License

Apache 2.0 - see [LICENSE](../../LICENSE)
