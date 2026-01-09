# Swift Client Design for Durable Streams

> **Status**: Design Document for Review
> **Author**: Claude
> **Date**: January 2026

## Executive Summary

This document proposes a Swift client implementation for the Durable Streams protocol, informed by research across 10+ streaming platforms (Kafka, NATS, Redis Streams, Pulsar, etc.) and aligned with Swift's modern concurrency features and API design guidelines.

---

## Table of Contents

1. [Design Principles](#design-principles)
2. [Architecture Overview](#architecture-overview)
3. [Core Types](#core-types)
4. [Stream API (Read-Only)](#stream-api-read-only)
5. [Handle API (Read/Write)](#handle-api-readwrite)
6. [Idempotent Producers](#idempotent-producers)
7. [Streaming Patterns](#streaming-patterns)
8. [Error Handling](#error-handling)
9. [Configuration](#configuration)
10. [Platform Considerations](#platform-considerations)
11. [API Reference](#api-reference)
12. [Implementation Roadmap](#implementation-roadmap)

---

## Design Principles

Based on research of Swift SDKs for Kafka (swift-kafka-client), NATS (nats.swift), RabbitMQ (rabbitmq-nio), and others, the following principles guide this design:

### 1. Swift-Native Concurrency

Use `AsyncSequence` and structured concurrency as the primary streaming interface—this is the idiomatic Swift pattern adopted by all modern Swift server SDKs.

```swift
// Preferred: AsyncSequence iteration
for try await message in stream.messages() {
    process(message)
}

// Also supported: Callback-based for legacy code
stream.subscribe { message in
    process(message)
}
```

### 2. Progressive Disclosure of Complexity

Simple use cases should be simple. Advanced features (idempotent producers, batching, CDN cursors) are opt-in.

```swift
// Simple: One-liner for reading
for try await msg in DurableStream.stream(url).json() { ... }

// Advanced: Full control
let handle = try await DurableStream.connect(url, configuration: .init(
    idempotentProducer: .enabled(producerId: "my-producer"),
    batching: .init(maxBytes: 64_000, lingerMs: 10)
))
```

### 3. Consistency with Existing Clients

API shapes mirror TypeScript, Python, and Go clients for cross-language familiarity while using Swift idioms.

### 4. Compile-Time Safety

Leverage Swift's type system to prevent runtime errors:
- Typed offsets prevent mixing up string parameters
- Enums for live modes eliminate invalid states
- Result builders for configuration

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                    Public API Layer                         │
├──────────────────────┬──────────────────────────────────────┤
│   Stream Function    │         Handle API                   │
│   (read-only)        │   (create/read/write/delete)         │
├──────────────────────┴──────────────────────────────────────┤
│                   Response Types                             │
│   StreamResponse<T> with multiple consumption methods        │
├─────────────────────────────────────────────────────────────┤
│                  Core Components                             │
│  ┌─────────────┐ ┌──────────────┐ ┌───────────────────────┐ │
│  │ HTTPClient  │ │ SSEParser    │ │ IdempotentProducer    │ │
│  │ (URLSession)│ │ (AsyncSeq)   │ │ (Actor)               │ │
│  └─────────────┘ └──────────────┘ └───────────────────────┘ │
│  ┌─────────────┐ ┌──────────────┐ ┌───────────────────────┐ │
│  │ BatchQueue  │ │ RetryHandler │ │ CursorManager         │ │
│  └─────────────┘ └──────────────┘ └───────────────────────┘ │
├─────────────────────────────────────────────────────────────┤
│                   Platform Adapters                          │
│          URLSession (iOS/macOS) | AsyncHTTPClient (Linux)   │
└─────────────────────────────────────────────────────────────┘
```

---

## Core Types

### Offset

Opaque, lexicographically sortable position marker.

```swift
/// Represents a position in a Durable Stream.
/// Offsets are opaque strings that can be compared lexicographically.
public struct Offset: Sendable, Hashable, Comparable, CustomStringConvertible {
    public let rawValue: String

    /// Start of stream (returns all messages)
    public static let start = Offset(rawValue: "-1")

    /// Current tail (only new messages)
    public static let now = Offset(rawValue: "now")

    /// Create from a raw offset string (typically from a previous read)
    public init(rawValue: String) {
        self.rawValue = rawValue
    }

    public static func < (lhs: Offset, rhs: Offset) -> Bool {
        lhs.rawValue < rhs.rawValue
    }

    public var description: String { rawValue }
}
```

### LiveMode

Controls real-time subscription behavior.

```swift
/// Specifies how the client should handle real-time updates.
public enum LiveMode: Sendable {
    /// Read existing data only, stop at end of stream
    case catchUp

    /// HTTP long-polling for updates (CDN-friendly)
    case longPoll

    /// Server-Sent Events for persistent connection
    case sse

    /// Auto-select based on consumption method:
    /// - .json()/.text() → catchUp
    /// - .jsonStream()/.bodyStream() → longPoll
    /// - .subscribe*() → sse
    case auto
}
```

### Message Types

```swift
/// A batch of JSON messages from the stream.
public struct JsonBatch<T: Decodable & Sendable>: Sendable {
    /// The decoded messages
    public let items: [T]

    /// Offset after the last message (use for resumption)
    public let offset: Offset

    /// True if caught up to the current tail
    public let upToDate: Bool

    /// Cursor for CDN cache collapsing (internal use)
    internal let cursor: String?
}

/// A chunk of bytes from the stream.
public struct ByteChunk: Sendable {
    /// Raw byte data
    public let data: Data

    /// Offset after this chunk
    public let offset: Offset

    /// True if caught up to the current tail
    public let upToDate: Bool
}

/// A text chunk from the stream.
public struct TextChunk: Sendable {
    /// UTF-8 decoded text
    public let text: String

    /// Offset after this chunk
    public let offset: Offset

    /// True if caught up to the current tail
    public let upToDate: Bool
}
```

### Stream Metadata

```swift
/// Metadata about a Durable Stream.
public struct StreamInfo: Sendable {
    /// Current tail offset
    public let offset: Offset

    /// Content type of the stream
    public let contentType: String?

    /// Stream expiration timestamp (if set)
    public let expires: Date?

    /// Cache control headers
    public let cacheControl: String?

    /// ETag for conditional requests
    public let etag: String?
}
```

---

## Stream API (Read-Only)

The stream function provides a simple, fetch-like interface for reading streams.

### Basic Usage

```swift
import DurableStreams

// Read all JSON messages
let messages = try await DurableStream.stream(url: streamURL)
    .json(as: [MyMessage].self)

// Stream from a specific offset
let response = try await DurableStream.stream(
    url: streamURL,
    offset: lastKnownOffset,
    live: .longPoll
)

// Iterate over messages as they arrive
for try await batch in response.jsonStream(as: MyMessage.self) {
    for message in batch.items {
        await process(message)
    }
}
```

### StreamResponse

The response object supports multiple consumption patterns:

```swift
/// Response from a stream request, supporting multiple consumption methods.
public struct StreamResponse<T: Sendable>: Sendable {

    // MARK: - Accumulators (collect all data)

    /// Accumulate all JSON messages into an array.
    /// Uses `.catchUp` live mode behavior.
    public func json<U: Decodable>(as type: U.Type) async throws -> [U]

    /// Accumulate all text content.
    public func text() async throws -> String

    /// Accumulate all bytes.
    public func bytes() async throws -> Data

    // MARK: - Streams (AsyncSequence)

    /// Stream JSON batches as they arrive.
    /// Uses `.longPoll` live mode by default.
    public func jsonStream<U: Decodable>(
        as type: U.Type
    ) -> AsyncThrowingStream<JsonBatch<U>, Error>

    /// Stream individual JSON items (flattens batches).
    public func jsonItems<U: Decodable>(
        as type: U.Type
    ) -> AsyncThrowingStream<U, Error>

    /// Stream byte chunks as they arrive.
    public func byteStream() -> AsyncThrowingStream<ByteChunk, Error>

    /// Stream text chunks as they arrive.
    public func textStream() -> AsyncThrowingStream<TextChunk, Error>

    // MARK: - Subscribers (with backpressure)

    /// Subscribe to JSON messages with explicit backpressure control.
    /// Uses `.sse` live mode for real-time delivery.
    public func subscribe<U: Decodable>(
        as type: U.Type,
        onMessage: @escaping @Sendable (JsonBatch<U>) async -> SubscriberAction
    ) async throws

    // MARK: - Metadata

    /// The HTTP response status
    public let status: Int

    /// Response headers
    public let headers: [String: String]

    /// The offset used for this request
    public let requestOffset: Offset
}

/// Control flow for subscribers
public enum SubscriberAction: Sendable {
    /// Continue receiving messages
    case `continue`

    /// Stop the subscription
    case stop

    /// Pause briefly before continuing (backpressure)
    case pauseFor(Duration)
}
```

### Dynamic Headers and Parameters

Headers and parameters can be closures evaluated per-request, enabling token refresh:

```swift
let response = try await DurableStream.stream(
    url: streamURL,
    offset: .start,
    live: .longPoll,
    headers: {
        // Called before each HTTP request (including retries)
        ["Authorization": "Bearer \(await tokenManager.currentToken())"]
    },
    parameters: {
        ["tenant": currentTenantId]
    }
)
```

---

## Handle API (Read/Write)

The Handle API provides stateful stream management with read/write capabilities.

### Creating and Connecting

```swift
/// A handle to a Durable Stream with read/write capabilities.
public actor DurableStreamHandle {

    /// Create a new stream.
    /// - Throws: `DurableStreamError.conflict` if stream already exists
    public static func create(
        url: URL,
        contentType: String = "application/json",
        expireAfter: Duration? = nil,
        configuration: HandleConfiguration = .default
    ) async throws -> DurableStreamHandle

    /// Connect to an existing stream.
    /// - Throws: `DurableStreamError.notFound` if stream doesn't exist
    public static func connect(
        url: URL,
        configuration: HandleConfiguration = .default
    ) async throws -> DurableStreamHandle

    /// Create if not exists, or connect if it does.
    public static func createOrConnect(
        url: URL,
        contentType: String = "application/json",
        expireAfter: Duration? = nil,
        configuration: HandleConfiguration = .default
    ) async throws -> DurableStreamHandle

    /// Get stream metadata without establishing a handle.
    public static func head(url: URL) async throws -> StreamInfo

    /// Delete a stream.
    public static func delete(url: URL) async throws
}
```

### Reading from a Handle

```swift
extension DurableStreamHandle {

    /// Create a stream response for reading.
    public func stream(
        offset: Offset = .start,
        live: LiveMode = .auto
    ) -> StreamResponse<Void>

    /// Convenience: iterate JSON messages
    public func messages<T: Decodable>(
        as type: T.Type,
        from offset: Offset = .start
    ) -> AsyncThrowingStream<T, Error>
}

// Usage
let handle = try await DurableStreamHandle.connect(url: streamURL)

for try await message in handle.messages(as: ChatMessage.self) {
    print("Received: \(message)")
}
```

### Writing to a Handle

```swift
extension DurableStreamHandle {

    /// Append a single JSON value.
    /// With idempotent producer enabled, this is fire-and-forget.
    @discardableResult
    public func append<T: Encodable>(_ value: T) async throws -> AppendResult

    /// Append multiple JSON values (sent as a single batch).
    @discardableResult
    public func append<T: Encodable>(batch values: [T]) async throws -> AppendResult

    /// Append raw bytes.
    @discardableResult
    public func appendBytes(_ data: Data) async throws -> AppendResult

    /// Stream bytes to the handle.
    public func appendStream(_ stream: AsyncStream<Data>) async throws -> AppendResult

    /// Flush pending batches (when using batching).
    public func flush() async throws

    /// Close the handle, flushing any pending writes.
    public func close() async throws
}

/// Result of an append operation.
public struct AppendResult: Sendable {
    /// The offset assigned to the appended data
    public let offset: Offset

    /// True if this was a duplicate (idempotent producer detected)
    public let isDuplicate: Bool
}
```

---

## Idempotent Producers

Implements Kafka-style exactly-once semantics with `(producerId, epoch, seq)` coordination.

### Configuration

```swift
/// Configuration for idempotent producer behavior.
public struct IdempotentProducerConfiguration: Sendable {
    /// Producer identifier (should be stable across restarts for deduplication)
    public let producerId: String

    /// Starting epoch (auto-incremented on fence errors)
    public var initialEpoch: Int

    /// Automatic epoch increment on 403 Forbidden
    public var autoClaimOnStaleEpoch: Bool

    /// Maximum concurrent in-flight batches
    public var maxInFlight: Int

    public static func enabled(
        producerId: String,
        initialEpoch: Int = 0,
        autoClaimOnStaleEpoch: Bool = true,
        maxInFlight: Int = 5
    ) -> IdempotentProducerConfiguration

    public static let disabled: IdempotentProducerConfiguration? = nil
}
```

### Internal Actor

```swift
/// Manages idempotent producer state with automatic batching.
internal actor IdempotentProducer {
    private let producerId: String
    private var epoch: Int
    private var sequence: Int = 0
    private var pendingBatches: [PendingBatch] = []
    private var inFlightBatches: [InFlightBatch] = []

    /// Queue an item for sending (returns immediately)
    func enqueue<T: Encodable>(_ item: T) async throws

    /// Queue multiple items
    func enqueue<T: Encodable>(batch items: [T]) async throws

    /// Wait for all pending items to be acknowledged
    func flush() async throws

    /// Handle stale epoch error (bump epoch, re-queue failed batches)
    func handleStaleEpoch() async throws

    /// Handle sequence gap error
    func handleSequenceGap(expected: Int, got: Int) async throws
}
```

### Usage

```swift
let handle = try await DurableStreamHandle.create(
    url: streamURL,
    configuration: .init(
        idempotentProducer: .enabled(producerId: "order-processor-\(instanceId)")
    )
)

// Fire-and-forget appends (internally batched and sequenced)
try await handle.append(OrderCreated(orderId: "123"))
try await handle.append(OrderUpdated(orderId: "123", status: .processing))
try await handle.append(OrderCompleted(orderId: "123"))

// Ensure all are persisted before proceeding
try await handle.flush()
```

---

## Streaming Patterns

### AsyncSequence Consumption

The primary pattern, following swift-kafka-client and nats.swift:

```swift
// Typed message iteration
for try await message in handle.messages(as: Event.self) {
    switch message {
    case .userCreated(let user):
        await userService.create(user)
    case .userUpdated(let update):
        await userService.update(update)
    }
}

// Batch iteration (for efficiency)
for try await batch in handle.stream().jsonStream(as: Event.self) {
    // Process multiple messages atomically
    try await database.transaction { tx in
        for event in batch.items {
            try await tx.apply(event)
        }
        try await tx.saveOffset(batch.offset)
    }
}
```

### SSE Parsing

Internal SSE parser following the EventSource specification:

```swift
/// Parses Server-Sent Events from an async byte stream.
internal struct SSEParser: AsyncSequence {
    typealias Element = SSEEvent

    let source: URLSession.AsyncBytes

    struct AsyncIterator: AsyncIteratorProtocol {
        mutating func next() async throws -> SSEEvent?
    }
}

/// A parsed SSE event.
internal struct SSEEvent: Sendable {
    let event: String?  // Event type (nil = "message")
    let data: String    // Event data
    let id: String?     // Event ID
    let retry: Int?     // Reconnection time in ms
}
```

### Long-Poll Loop

Internal long-poll implementation with cursor handling:

```swift
internal func longPollLoop<T: Decodable>(
    url: URL,
    offset: Offset,
    type: T.Type,
    continuation: AsyncThrowingStream<JsonBatch<T>, Error>.Continuation
) async {
    var currentOffset = offset
    var cursor: String? = nil

    while !Task.isCancelled {
        do {
            var request = URLRequest(url: url)
            request.setValue(currentOffset.rawValue, forHTTPHeaderField: "Last-Event-ID")
            if let cursor = cursor {
                request.url?.append(queryItems: [URLQueryItem(name: "cursor", value: cursor)])
            }

            let (data, response) = try await urlSession.data(for: request)

            guard let httpResponse = response as? HTTPURLResponse else { continue }

            switch httpResponse.statusCode {
            case 200:
                let batch = try decode(data, as: type, from: httpResponse)
                continuation.yield(batch)
                currentOffset = batch.offset
                cursor = batch.cursor

            case 204:
                // Timeout, retry with same offset
                continue

            case 410:
                continuation.finish(throwing: DurableStreamError.retentionExpired)
                return

            default:
                try handleError(httpResponse, data)
            }
        } catch {
            if await retryHandler.shouldRetry(after: error) {
                continue
            }
            continuation.finish(throwing: error)
            return
        }
    }

    continuation.finish()
}
```

---

## Error Handling

### Error Types

```swift
/// Errors specific to Durable Streams operations.
public enum DurableStreamError: Error, Sendable {
    // MARK: - Client Errors (4xx)

    /// Stream already exists (409 on create)
    case conflict(message: String)

    /// Stream not found (404)
    case notFound(url: URL)

    /// Authentication required (401)
    case unauthorized(message: String)

    /// Permission denied (403, non-producer context)
    case forbidden(message: String)

    /// Request malformed (400)
    case badRequest(message: String)

    /// Data expired due to retention policy (410)
    case retentionExpired(offset: Offset)

    /// Rate limited (429)
    case rateLimited(retryAfter: Duration?)

    // MARK: - Producer Errors

    /// Producer epoch is stale (403 in producer context)
    case staleEpoch(producerId: String, currentEpoch: Int)

    /// Sequence number gap detected (409 in producer context)
    case sequenceGap(expected: Int, received: Int)

    // MARK: - Server Errors (5xx)

    /// Server temporarily unavailable (503)
    case serverBusy(retryAfter: Duration?)

    /// Generic server error
    case serverError(status: Int, message: String)

    // MARK: - Network Errors

    /// Connection failed
    case connectionFailed(underlying: Error)

    /// Request timed out
    case timeout

    /// SSE not supported by server
    case sseNotSupported
}

extension DurableStreamError: LocalizedError {
    public var errorDescription: String? {
        switch self {
        case .conflict(let message):
            return "Stream conflict: \(message)"
        case .notFound(let url):
            return "Stream not found: \(url)"
        // ... etc
        }
    }
}
```

### Custom Error Handler

```swift
/// Custom error handling for stream operations.
public struct StreamErrorHandler: Sendable {
    public typealias Handler = @Sendable (DurableStreamError) async -> ErrorAction

    let handler: Handler

    public init(_ handler: @escaping Handler) {
        self.handler = handler
    }

    /// Default handler: propagate all errors
    public static let `default` = StreamErrorHandler { _ in .propagate }

    /// Retry transient errors with exponential backoff
    public static let retryTransient = StreamErrorHandler { error in
        switch error {
        case .serverBusy, .rateLimited, .connectionFailed, .timeout:
            return .retry
        default:
            return .propagate
        }
    }
}

public enum ErrorAction: Sendable {
    /// Re-throw the error to the caller
    case propagate

    /// Retry the operation
    case retry

    /// Retry after a specific delay
    case retryAfter(Duration)

    /// Ignore and continue (for subscribers)
    case `continue`
}
```

---

## Configuration

### HandleConfiguration

```swift
/// Configuration for a DurableStreamHandle.
public struct HandleConfiguration: Sendable {
    /// Idempotent producer settings (nil to disable)
    public var idempotentProducer: IdempotentProducerConfiguration?

    /// Batching configuration
    public var batching: BatchingConfiguration

    /// HTTP client configuration
    public var http: HTTPConfiguration

    /// Error handling
    public var errorHandler: StreamErrorHandler

    /// Default configuration
    public static let `default` = HandleConfiguration()

    public init(
        idempotentProducer: IdempotentProducerConfiguration? = nil,
        batching: BatchingConfiguration = .default,
        http: HTTPConfiguration = .default,
        errorHandler: StreamErrorHandler = .default
    ) {
        self.idempotentProducer = idempotentProducer
        self.batching = batching
        self.http = http
        self.errorHandler = errorHandler
    }
}

/// Batching configuration for append operations.
public struct BatchingConfiguration: Sendable {
    /// Maximum bytes per batch
    public var maxBytes: Int

    /// Time to wait for more items before sending
    public var lingerTime: Duration

    /// Disable batching (send immediately)
    public static let disabled = BatchingConfiguration(maxBytes: 0, lingerTime: .zero)

    /// Default: 64KB max, 5ms linger
    public static let `default` = BatchingConfiguration(
        maxBytes: 64_000,
        lingerTime: .milliseconds(5)
    )
}

/// HTTP client configuration.
public struct HTTPConfiguration: Sendable {
    /// Request timeout
    public var timeout: Duration

    /// Long-poll timeout (server-side)
    public var longPollTimeout: Duration

    /// Maximum retry attempts
    public var maxRetries: Int

    /// Base delay for exponential backoff
    public var retryBaseDelay: Duration

    /// Custom URLSession (nil uses shared)
    public var urlSession: URLSession?

    public static let `default` = HTTPConfiguration(
        timeout: .seconds(30),
        longPollTimeout: .seconds(55),
        maxRetries: 3,
        retryBaseDelay: .milliseconds(100)
    )
}
```

### Result Builder for Complex Configuration

```swift
@resultBuilder
public struct HandleConfigurationBuilder {
    public static func buildBlock(_ components: ConfigurationComponent...) -> HandleConfiguration {
        var config = HandleConfiguration()
        for component in components {
            component.apply(to: &config)
        }
        return config
    }
}

public protocol ConfigurationComponent {
    func apply(to config: inout HandleConfiguration)
}

// Usage with result builder
let handle = try await DurableStreamHandle.create(url: streamURL) {
    IdempotentProducer(id: "my-producer")
    Batching(maxBytes: 128_000, linger: .milliseconds(10))
    Retry(maxAttempts: 5, backoff: .exponential(base: .milliseconds(100)))
}
```

---

## Platform Considerations

### iOS App Lifecycle

Following NATS.swift's pattern for mobile apps:

```swift
/// Manages stream connections across iOS app lifecycle.
public actor StreamLifecycleManager {
    private var handles: [URL: DurableStreamHandle] = [:]
    private var suspendedState: [URL: SuspendedStreamState] = [:]

    /// Suspend all active streams (call from sceneWillResignActive)
    public func suspendAll() async {
        for (url, handle) in handles {
            let state = await handle.suspend()
            suspendedState[url] = state
        }
    }

    /// Resume all suspended streams (call from sceneDidBecomeActive)
    public func resumeAll() async throws {
        for (url, state) in suspendedState {
            if let handle = handles[url] {
                try await handle.resume(from: state)
            }
        }
        suspendedState.removeAll()
    }
}

// Integration with SwiftUI
struct ContentView: View {
    @StateObject private var streamManager = StreamManager()

    var body: some View {
        MessageList(messages: streamManager.messages)
            .onReceive(NotificationCenter.default.publisher(
                for: UIApplication.willResignActiveNotification
            )) { _ in
                Task { await streamManager.suspend() }
            }
            .onReceive(NotificationCenter.default.publisher(
                for: UIApplication.didBecomeActiveNotification
            )) { _ in
                Task { try await streamManager.resume() }
            }
    }
}
```

### Background Tasks (iOS)

```swift
extension DurableStreamHandle {
    /// Request background time for flushing pending writes.
    public func requestBackgroundFlush() async throws {
        #if os(iOS)
        let taskId = UIApplication.shared.beginBackgroundTask {
            // Handle expiration
        }

        defer {
            UIApplication.shared.endBackgroundTask(taskId)
        }

        try await flush()
        #else
        try await flush()
        #endif
    }
}
```

### Linux Server Support

For server-side Swift, use AsyncHTTPClient instead of URLSession:

```swift
#if canImport(AsyncHTTPClient)
import AsyncHTTPClient

extension DurableStreamHandle {
    /// Create a handle using AsyncHTTPClient (for Linux/server)
    public static func create(
        url: URL,
        httpClient: HTTPClient,
        configuration: HandleConfiguration = .default
    ) async throws -> DurableStreamHandle
}
#endif
```

### Service Lifecycle Integration

Following swift-service-lifecycle patterns:

```swift
import ServiceLifecycle

extension DurableStreamHandle: Service {
    public func run() async throws {
        // Keep the handle alive until cancelled
        try await withTaskCancellationHandler {
            try await Task.sleep(for: .seconds(.max))
        } onCancel: {
            Task { try await self.close() }
        }
    }
}

// Usage with ServiceGroup
let streamHandle = try await DurableStreamHandle.connect(url: streamURL)
let consumer = StreamConsumer(handle: streamHandle)

let serviceGroup = ServiceGroup(
    services: [streamHandle, consumer],
    configuration: .init(gracefulShutdownSignals: [.sigterm]),
    logger: logger
)

try await serviceGroup.run()
```

---

## API Reference

### Module Structure

```
DurableStreams/
├── DurableStream.swift          // Main entry point
├── Types/
│   ├── Offset.swift
│   ├── LiveMode.swift
│   ├── Messages.swift           // JsonBatch, ByteChunk, etc.
│   └── StreamInfo.swift
├── Stream/
│   ├── StreamResponse.swift
│   └── StreamOptions.swift
├── Handle/
│   ├── DurableStreamHandle.swift
│   ├── HandleConfiguration.swift
│   └── AppendResult.swift
├── Producer/
│   ├── IdempotentProducer.swift
│   ├── BatchQueue.swift
│   └── ProducerConfiguration.swift
├── Internal/
│   ├── HTTPClient.swift
│   ├── SSEParser.swift
│   ├── LongPollLoop.swift
│   ├── CursorManager.swift
│   └── RetryHandler.swift
├── Errors/
│   └── DurableStreamError.swift
└── Platform/
    ├── iOSLifecycle.swift
    └── LinuxSupport.swift
```

### Quick Reference

| Operation | Method | Returns |
|-----------|--------|---------|
| Read stream (simple) | `DurableStream.stream(url:)` | `StreamResponse` |
| Read JSON array | `.json(as:)` | `[T]` |
| Stream JSON batches | `.jsonStream(as:)` | `AsyncThrowingStream<JsonBatch<T>>` |
| Stream items | `.jsonItems(as:)` | `AsyncThrowingStream<T>` |
| Create stream | `DurableStreamHandle.create(url:)` | `DurableStreamHandle` |
| Connect to stream | `DurableStreamHandle.connect(url:)` | `DurableStreamHandle` |
| Append JSON | `handle.append(_:)` | `AppendResult` |
| Append batch | `handle.append(batch:)` | `AppendResult` |
| Get metadata | `DurableStreamHandle.head(url:)` | `StreamInfo` |
| Delete stream | `DurableStreamHandle.delete(url:)` | `Void` |

---

## Implementation Roadmap

### Phase 1: Core Reading (MVP)

- [ ] `Offset` type
- [ ] `DurableStream.stream()` function
- [ ] `StreamResponse` with `.json()`, `.text()`, `.bytes()`
- [ ] Basic HTTP client wrapper
- [ ] Error types
- [ ] Unit tests

### Phase 2: Streaming

- [ ] SSE parser
- [ ] Long-poll loop
- [ ] `.jsonStream()`, `.bodyStream()`
- [ ] Cursor management for CDN
- [ ] Retry handling

### Phase 3: Handle API

- [ ] `DurableStreamHandle` actor
- [ ] Create/connect/head/delete operations
- [ ] Basic append (non-idempotent)
- [ ] Dynamic headers/parameters

### Phase 4: Idempotent Producers

- [ ] `IdempotentProducer` actor
- [ ] Epoch/sequence management
- [ ] Automatic batching
- [ ] Stale epoch handling
- [ ] Sequence gap recovery

### Phase 5: Platform Polish

- [ ] iOS lifecycle management
- [ ] Background task support
- [ ] Linux/AsyncHTTPClient support
- [ ] Service lifecycle integration
- [ ] Documentation

### Phase 6: Conformance

- [ ] Swift test adapter for conformance tests
- [ ] Pass all consumer conformance tests
- [ ] Pass all producer conformance tests
- [ ] Pass all lifecycle conformance tests

---

## Appendix: Comparison with Other Clients

| Feature | TypeScript | Python | Go | Swift (Proposed) |
|---------|------------|--------|----|------------------|
| Async model | Promise/async-await | asyncio | goroutines | async/await |
| Streaming | AsyncIterator | AsyncIterator | channels | AsyncSequence |
| HTTP client | fetch | aiohttp | net/http | URLSession |
| SSE support | EventSource | aiohttp-sse | custom | custom |
| Batching | auto | auto | auto | auto |
| Idempotent producer | yes | yes | yes | yes |
| Type safety | TypeScript | runtime | compile-time | compile-time |

---

## Open Questions

1. **Package name**: `DurableStreams`, `DurableStreamClient`, or `swift-durable-streams`?

2. **Minimum Swift version**: Swift 5.9 (for parameter packs) or Swift 5.7 (wider compatibility)?

3. **Dependency policy**: Zero dependencies for core, optional AsyncHTTPClient for Linux?

4. **Combine support**: Should we provide Combine publishers for UIKit apps, or focus on async/await only?

5. **Codable flexibility**: Should we support custom JSON decoders, or always use the standard `JSONDecoder`?

---

*This design document is open for review. Please provide feedback on API ergonomics, naming conventions, and any missing features.*
