# Durable Streams Rust Client Design

## Executive Summary

This document proposes a design for a Rust client library for the Durable Streams protocol. The design synthesizes best practices from 10 major streaming platform Rust SDKs: Kafka (rdkafka), Redis Streams, NATS JetStream, Apache Pulsar, AWS Kinesis, Google Cloud Pub/Sub, Azure Event Hubs, RabbitMQ Streams, Apache Flink, and Redpanda.

## Design Principles

Based on analysis of existing Rust streaming SDKs, the following principles guide this design:

1. **Idiomatic Rust**: Use traits, generics, `Result<T, E>`, and the ownership system effectively
2. **Async-First**: Built on `tokio` with `async/await`, implementing `futures::Stream` where appropriate
3. **Zero-Cost Abstractions**: Tiered API (low-level and high-level) like rdkafka
4. **Builder Pattern**: Configuration via fluent builders (pulsar-rs, async-nats pattern)
5. **Type Safety**: Strong typing for protocol concepts (offsets, live modes, etc.)
6. **Minimal Dependencies**: Core functionality with optional feature flags
7. **Protocol Parity**: Support all Durable Streams protocol features

---

## API Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                         User-Facing API                          │
├─────────────────────────────────────────────────────────────────┤
│  stream()          DurableStream        IdempotentProducer      │
│  (functional)      (handle class)       (exactly-once)          │
├─────────────────────────────────────────────────────────────────┤
│                      Core Abstractions                           │
├─────────────────────────────────────────────────────────────────┤
│  StreamResponse    Chunk               ChunkIterator            │
│  (consumption)     (data unit)         (async iteration)        │
├─────────────────────────────────────────────────────────────────┤
│                      HTTP Transport                              │
├─────────────────────────────────────────────────────────────────┤
│  HttpClient        BackoffPolicy       SSE Parser               │
│  (reqwest-based)   (retry logic)       (event stream)           │
└─────────────────────────────────────────────────────────────────┘
```

---

## Core Types

### 1. Client Configuration

Following the builder pattern from pulsar-rs and async-nats:

```rust
use std::time::Duration;

/// Main client configuration builder
pub struct ClientConfig {
    /// Base URL for the stream (without path)
    base_url: Option<String>,
    /// Default headers for all requests
    default_headers: HeaderMap,
    /// HTTP client configuration
    http_config: HttpConfig,
    /// Retry/backoff configuration
    retry_config: RetryConfig,
}

impl ClientConfig {
    pub fn new() -> Self { ... }

    pub fn base_url(mut self, url: impl Into<String>) -> Self { ... }

    pub fn default_header(mut self, key: impl Into<String>, value: impl Into<String>) -> Self { ... }

    /// Dynamic header provider (called per-request, like TS client)
    pub fn header_provider<F>(mut self, provider: F) -> Self
    where
        F: Fn() -> HeaderMap + Send + Sync + 'static { ... }

    pub fn retry_config(mut self, config: RetryConfig) -> Self { ... }

    pub fn timeout(mut self, timeout: Duration) -> Self { ... }

    pub fn build(self) -> Result<Client, ConfigError> { ... }
}

/// Retry/backoff configuration (pattern from AWS SDK)
#[derive(Clone, Debug)]
pub struct RetryConfig {
    pub initial_backoff: Duration,
    pub max_backoff: Duration,
    pub multiplier: f64,
    pub max_retries: Option<u32>, // None = infinite
}

impl Default for RetryConfig {
    fn default() -> Self {
        Self {
            initial_backoff: Duration::from_millis(100),
            max_backoff: Duration::from_secs(60),
            multiplier: 1.3,
            max_retries: None,
        }
    }
}
```

### 2. Stream Handle

Lightweight handle pattern from Go client - no connection held:

```rust
/// A handle to a durable stream (stateless, cloneable)
#[derive(Clone)]
pub struct DurableStream {
    url: String,
    client: Client,
    content_type: Option<String>, // Cached after create/head
}

impl DurableStream {
    /// Create a new stream
    pub async fn create(&self, options: CreateOptions) -> Result<CreateResponse, StreamError> { ... }

    /// Append data to the stream
    pub async fn append(&self, data: impl Into<Bytes>) -> Result<AppendResponse, StreamError> { ... }

    /// Append JSON data (auto-serializes)
    pub async fn append_json<T: Serialize>(&self, data: &T) -> Result<AppendResponse, StreamError> { ... }

    /// Get stream metadata
    pub async fn head(&self) -> Result<HeadResponse, StreamError> { ... }

    /// Delete the stream
    pub async fn delete(&self) -> Result<(), StreamError> { ... }

    /// Create a reader for consuming the stream
    pub fn reader(&self) -> ReaderBuilder { ... }

    /// Create an idempotent producer
    pub fn producer(&self, producer_id: impl Into<String>) -> ProducerBuilder { ... }
}
```

### 3. Offset Type

Type-safe offset handling:

```rust
/// Stream position specification
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Offset {
    /// Start from the beginning of the stream
    Beginning,
    /// Start from the current tail (only future data)
    Now,
    /// Start from a specific offset token
    At(String),
}

impl Offset {
    /// Parse from protocol string
    pub fn parse(s: &str) -> Self {
        match s {
            "-1" => Offset::Beginning,
            "now" => Offset::Now,
            other => Offset::At(other.to_string()),
        }
    }

    /// Convert to query parameter value
    pub fn to_query_value(&self) -> &str {
        match self {
            Offset::Beginning => "-1",
            Offset::Now => "now",
            Offset::At(s) => s.as_str(),
        }
    }
}

impl PartialOrd for Offset {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        match (self, other) {
            (Offset::At(a), Offset::At(b)) => Some(a.cmp(b)), // Lexicographic
            _ => None, // Sentinels not comparable
        }
    }
}
```

### 4. Live Mode

```rust
/// Live tailing mode for stream consumption
#[derive(Clone, Debug, Default)]
pub enum LiveMode {
    /// No live tailing - stop when caught up
    #[default]
    Off,
    /// Automatic selection (SSE preferred, falls back to long-poll)
    Auto,
    /// Explicit long-polling
    LongPoll,
    /// Explicit Server-Sent Events
    Sse,
}
```

---

## Stream Consumption

### 5. Reader/Iterator Pattern

Following Go's `ChunkIterator` and rdkafka's `StreamConsumer`:

```rust
/// Builder for configuring stream readers
pub struct ReaderBuilder<'a> {
    stream: &'a DurableStream,
    offset: Offset,
    live: LiveMode,
    on_error: Option<Box<dyn ErrorHandler>>,
}

impl<'a> ReaderBuilder<'a> {
    pub fn offset(mut self, offset: Offset) -> Self { ... }

    pub fn live(mut self, mode: LiveMode) -> Self { ... }

    /// Error handler for recoverable errors (pattern from TS/Python clients)
    pub fn on_error<F>(mut self, handler: F) -> Self
    where
        F: Fn(&StreamError) -> ErrorAction + Send + Sync + 'static { ... }

    /// Build a chunk iterator
    pub async fn chunks(self) -> Result<ChunkIterator, StreamError> { ... }

    /// Build a bytes stream
    pub async fn bytes(self) -> Result<impl Stream<Item = Result<Bytes, StreamError>>, StreamError> { ... }

    /// Build a JSON stream (for application/json streams)
    pub async fn json<T: DeserializeOwned>(self) -> Result<impl Stream<Item = Result<T, StreamError>>, StreamError> { ... }
}

/// Action to take after an error
pub enum ErrorAction {
    /// Retry with optionally modified headers/params
    Retry { headers: Option<HeaderMap> },
    /// Stop iteration and propagate error
    Stop,
}

/// Low-level chunk iterator (like Go's ChunkIterator)
pub struct ChunkIterator {
    // Internal state
    stream_url: String,
    client: Client,
    offset: Offset,
    cursor: Option<String>,
    live: LiveMode,
    up_to_date: bool,
    // ... internal http state
}

impl ChunkIterator {
    /// Current offset position
    pub fn offset(&self) -> &Offset { ... }

    /// Whether we've caught up to the stream tail
    pub fn is_up_to_date(&self) -> bool { ... }

    /// Current cursor for CDN collapsing
    pub fn cursor(&self) -> Option<&str> { ... }

    /// Fetch next chunk (async)
    pub async fn next(&mut self) -> Result<Option<Chunk>, StreamError> { ... }

    /// Cancel and clean up
    pub async fn close(self) -> Result<(), StreamError> { ... }
}

/// A chunk of data from the stream
#[derive(Debug)]
pub struct Chunk {
    /// The data bytes
    pub data: Bytes,
    /// Next offset to read from
    pub next_offset: Offset,
    /// Whether this response indicates we're caught up
    pub up_to_date: bool,
    /// Cursor for subsequent requests
    pub cursor: Option<String>,
}
```

### 6. Stream Trait Implementation

Implementing `futures::Stream` for ergonomic async iteration:

```rust
impl Stream for ChunkIterator {
    type Item = Result<Chunk, StreamError>;

    fn poll_next(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        // Implementation delegates to internal async state machine
        ...
    }
}

// Usage:
use futures::StreamExt;

let mut chunks = stream.reader()
    .offset(Offset::Beginning)
    .live(LiveMode::Auto)
    .chunks()
    .await?;

while let Some(chunk) = chunks.next().await {
    let chunk = chunk?;
    println!("Got {} bytes at offset {:?}", chunk.data.len(), chunk.next_offset);
}
```

---

## Idempotent Producer

### 7. Fire-and-Forget Producer

Following Kafka's idempotent producer pattern and the existing TS/Python/Go implementations:

```rust
/// Builder for idempotent producers
pub struct ProducerBuilder<'a> {
    stream: &'a DurableStream,
    producer_id: String,
    epoch: u64,
    auto_claim: bool,
    max_batch_bytes: usize,
    linger: Duration,
    max_in_flight: usize,
}

impl<'a> ProducerBuilder<'a> {
    pub fn epoch(mut self, epoch: u64) -> Self { ... }

    /// Auto-claim producer ID on stale epoch (serverless pattern)
    pub fn auto_claim(mut self, enabled: bool) -> Self { ... }

    pub fn max_batch_bytes(mut self, bytes: usize) -> Self { ... }

    pub fn linger(mut self, duration: Duration) -> Self { ... }

    pub fn max_in_flight(mut self, count: usize) -> Self { ... }

    pub fn build(self) -> IdempotentProducer { ... }
}

/// Idempotent producer with exactly-once semantics
pub struct IdempotentProducer {
    // Internal state managed by background task
    inner: Arc<ProducerInner>,
    handle: tokio::task::JoinHandle<()>,
}

impl IdempotentProducer {
    /// Append data (fire-and-forget, batched internally)
    /// Returns immediately - data queued for sending
    pub fn append(&self, data: impl Into<Bytes>) -> Result<(), ProducerError> { ... }

    /// Append JSON data
    pub fn append_json<T: Serialize>(&self, data: &T) -> Result<(), ProducerError> { ... }

    /// Flush all pending data and wait for acknowledgment
    pub async fn flush(&self) -> Result<(), ProducerError> { ... }

    /// Close the producer gracefully
    pub async fn close(self) -> Result<(), ProducerError> { ... }
}
```

### 8. Producer Error Types

```rust
/// Producer-specific errors
#[derive(Debug, thiserror::Error)]
pub enum ProducerError {
    #[error("producer is closed")]
    Closed,

    #[error("stale epoch: server has epoch {server_epoch}, we have {our_epoch}")]
    StaleEpoch {
        server_epoch: u64,
        our_epoch: u64,
    },

    #[error("sequence gap: expected {expected}, received {received}")]
    SequenceGap {
        expected: u64,
        received: u64,
    },

    #[error("stream error: {0}")]
    Stream(#[from] StreamError),
}
```

---

## Error Handling

### 9. Error Hierarchy

Following the pattern from existing clients with typed error codes:

```rust
use thiserror::Error;

/// Main error type for stream operations
#[derive(Debug, Error)]
pub enum StreamError {
    #[error("stream not found: {url}")]
    NotFound { url: String },

    #[error("stream already exists with different configuration")]
    Conflict,

    #[error("content type mismatch: expected {expected}, got {actual}")]
    ContentTypeMismatch { expected: String, actual: String },

    #[error("sequence conflict: {0}")]
    SeqConflict(String),

    #[error("offset gone (retention/compaction): {offset}")]
    OffsetGone { offset: String },

    #[error("unauthorized")]
    Unauthorized,

    #[error("forbidden")]
    Forbidden,

    #[error("rate limited")]
    RateLimited { retry_after: Option<Duration> },

    #[error("invalid request: {message}")]
    BadRequest { message: String },

    #[error("server error: {status} - {message}")]
    ServerError { status: u16, message: String },

    #[error("network error: {0}")]
    Network(#[source] reqwest::Error),

    #[error("timeout")]
    Timeout,

    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),

    #[error("sse not supported for content type: {content_type}")]
    SseNotSupported { content_type: String },
}

impl StreamError {
    /// Whether this error is retryable
    pub fn is_retryable(&self) -> bool {
        matches!(self,
            StreamError::RateLimited { .. } |
            StreamError::ServerError { status, .. } if *status >= 500 |
            StreamError::Network(_) |
            StreamError::Timeout
        )
    }

    /// HTTP status code if applicable
    pub fn status_code(&self) -> Option<u16> {
        match self {
            StreamError::NotFound { .. } => Some(404),
            StreamError::Conflict => Some(409),
            StreamError::Unauthorized => Some(401),
            StreamError::Forbidden => Some(403),
            StreamError::RateLimited { .. } => Some(429),
            StreamError::BadRequest { .. } => Some(400),
            StreamError::ServerError { status, .. } => Some(*status),
            _ => None,
        }
    }
}
```

---

## Response Types

### 10. Operation Responses

```rust
/// Response from stream creation
#[derive(Debug)]
pub struct CreateResponse {
    pub next_offset: Offset,
    pub content_type: String,
}

/// Response from append operation
#[derive(Debug)]
pub struct AppendResponse {
    pub next_offset: Offset,
}

/// Response from HEAD operation
#[derive(Debug)]
pub struct HeadResponse {
    pub next_offset: Offset,
    pub content_type: String,
    pub ttl: Option<Duration>,
    pub expires_at: Option<DateTime<Utc>>,
}
```

---

## Feature Flags

```toml
[features]
default = ["tokio-runtime", "json"]

# Async runtime
tokio-runtime = ["tokio", "reqwest/tokio"]

# JSON support (serde)
json = ["serde", "serde_json"]

# TLS backends (mutually exclusive)
native-tls = ["reqwest/native-tls"]
rustls = ["reqwest/rustls-tls"]

# Tracing integration
tracing = ["dep:tracing"]

# Compression support
compression = ["reqwest/gzip", "reqwest/brotli"]
```

---

## Usage Examples

### Basic Reading

```rust
use durable_streams::{Client, DurableStream, Offset, LiveMode};
use futures::StreamExt;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Create client
    let client = Client::builder()
        .default_header("Authorization", "Bearer token")
        .build()?;

    // Get stream handle
    let stream = client.stream("https://api.example.com/streams/my-stream");

    // Read all data, then tail for new data
    let mut reader = stream.reader()
        .offset(Offset::Beginning)
        .live(LiveMode::Auto)
        .chunks()
        .await?;

    while let Some(result) = reader.next().await {
        let chunk = result?;
        println!("Received {} bytes", chunk.data.len());

        if chunk.up_to_date {
            println!("Caught up! Now tailing for new data...");
        }
    }

    Ok(())
}
```

### JSON Streaming

```rust
use durable_streams::{Client, Offset, LiveMode};
use futures::StreamExt;
use serde::Deserialize;

#[derive(Debug, Deserialize)]
struct Event {
    id: String,
    data: serde_json::Value,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let client = Client::builder().build()?;
    let stream = client.stream("https://api.example.com/streams/events");

    // Stream as typed JSON
    let mut events = stream.reader()
        .offset(Offset::Now) // Only new events
        .live(LiveMode::Sse)
        .json::<Event>()
        .await?;

    while let Some(result) = events.next().await {
        let event = result?;
        println!("Event: {:?}", event);
    }

    Ok(())
}
```

### Idempotent Producer

```rust
use durable_streams::{Client, DurableStream};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let client = Client::builder().build()?;
    let stream = client.stream("https://api.example.com/streams/orders");

    // Create the stream
    stream.create(Default::default()).await?;

    // Create idempotent producer
    let producer = stream.producer("order-service-1")
        .epoch(0)
        .auto_claim(true) // Auto-recover on restart
        .linger(Duration::from_millis(5))
        .build();

    // Fire-and-forget writes
    for i in 0..1000 {
        producer.append_json(&serde_json::json!({
            "order_id": i,
            "status": "created"
        }))?;
    }

    // Ensure all data is written
    producer.flush().await?;
    producer.close().await?;

    Ok(())
}
```

### Error Handling with Recovery

```rust
use durable_streams::{Client, Offset, LiveMode, StreamError, ErrorAction};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let client = Client::builder()
        .header_provider(|| {
            // Refresh auth token on each request
            let token = get_fresh_token();
            let mut headers = HeaderMap::new();
            headers.insert("Authorization", format!("Bearer {}", token).parse().unwrap());
            headers
        })
        .build()?;

    let stream = client.stream("https://api.example.com/streams/data");

    let mut reader = stream.reader()
        .offset(Offset::Beginning)
        .live(LiveMode::Auto)
        .on_error(|err| {
            match err {
                StreamError::Unauthorized => {
                    // Token might be expired, retry will get fresh token
                    ErrorAction::Retry { headers: None }
                }
                StreamError::RateLimited { retry_after } => {
                    // Could log or adjust behavior
                    ErrorAction::Retry { headers: None }
                }
                _ => ErrorAction::Stop,
            }
        })
        .chunks()
        .await?;

    // Process with automatic error recovery
    while let Some(chunk) = reader.next().await {
        let chunk = chunk?;
        process(chunk.data);
    }

    Ok(())
}
```

---

## Internal Architecture

### HTTP Layer

```rust
/// Internal HTTP client wrapper with retry logic
struct HttpClient {
    inner: reqwest::Client,
    retry_config: RetryConfig,
    header_provider: Option<Box<dyn Fn() -> HeaderMap + Send + Sync>>,
}

impl HttpClient {
    async fn request(&self, req: Request) -> Result<Response, StreamError> {
        let mut attempts = 0;
        let mut delay = self.retry_config.initial_backoff;

        loop {
            // Add dynamic headers
            let mut req = req.try_clone().ok_or(StreamError::Network(...))?;
            if let Some(provider) = &self.header_provider {
                for (k, v) in provider().iter() {
                    req.headers_mut().insert(k.clone(), v.clone());
                }
            }

            match self.inner.execute(req).await {
                Ok(resp) if resp.status().is_success() => return Ok(resp),
                Ok(resp) => {
                    let err = StreamError::from_response(resp).await;
                    if !err.is_retryable() || self.should_stop(attempts) {
                        return Err(err);
                    }
                }
                Err(e) => {
                    if self.should_stop(attempts) {
                        return Err(StreamError::Network(e));
                    }
                }
            }

            tokio::time::sleep(delay).await;
            delay = std::cmp::min(
                Duration::from_secs_f64(delay.as_secs_f64() * self.retry_config.multiplier),
                self.retry_config.max_backoff,
            );
            attempts += 1;
        }
    }
}
```

### SSE Parser

```rust
/// Server-Sent Events parser
struct SseParser {
    buffer: String,
    event_type: Option<String>,
    data_lines: Vec<String>,
}

impl SseParser {
    fn feed(&mut self, chunk: &[u8]) -> Vec<SseEvent> {
        // Line-buffered parsing following SSE spec
        // Returns complete events
        ...
    }
}

struct SseEvent {
    event_type: Option<String>,
    data: String,
}
```

---

## Comparison with Existing Clients

| Feature | TypeScript | Python | Go | Rust (Proposed) |
|---------|-----------|--------|-----|-----------------|
| API Style | Functional + Class | Functional + Class | Functional + Methods | Trait + Builder |
| Async | Promise | async/await + sync | context.Context | async/await (tokio) |
| Streaming | ReadableStream | Iterator | Iterator | futures::Stream |
| Error Handling | Typed codes | Typed exceptions | Wrapped sentinels | thiserror enum |
| Consumption | Multiple modes | One-shot | Iterator | Stream trait |
| Type Safety | TypeScript | Runtime | Compile-time | Compile-time |
| Zero-copy | No | No | Yes | Yes (Bytes) |

---

## Dependencies

```toml
[dependencies]
# Async runtime
tokio = { version = "1", features = ["rt-multi-thread", "macros", "time"] }

# HTTP client
reqwest = { version = "0.12", default-features = false, features = ["stream"] }

# Async streams
futures = "0.3"
async-stream = "0.3"

# Bytes handling
bytes = "1"

# Error handling
thiserror = "2"

# JSON (optional)
serde = { version = "1", features = ["derive"], optional = true }
serde_json = { version = "1", optional = true }

# Datetime
chrono = { version = "0.4", features = ["serde"] }

# HTTP types
http = "1"

# Tracing (optional)
tracing = { version = "0.1", optional = true }
```

---

## Testing Strategy

Following the project's philosophy of preferring conformance tests:

1. **Client Conformance Tests**: Add Rust to the existing conformance test runner
2. **Adapter Implementation**: Create test adapter that spawns Rust client binary
3. **Protocol Coverage**: Ensure all protocol features are tested via conformance suite

```yaml
# packages/client-conformance-tests/adapters/rust.yaml
name: rust
command: cargo run --release --manifest-path ../client-rust/Cargo.toml -- adapter
```

---

## Open Questions for Review

1. **Sync API**: Should we provide a blocking API wrapper (like rdkafka's `BaseConsumer` vs `StreamConsumer`)?

2. **Connection Pooling**: reqwest handles this internally - is explicit pool configuration needed?

3. **Batching for Reads**: Should `ChunkIterator` support prefetching/buffering for higher throughput?

4. **Cancellation Token**: Use `tokio_util::sync::CancellationToken` or `AbortHandle` pattern?

5. **Generic HTTP Client**: Abstract over HTTP client (reqwest, hyper, etc.) via trait?

6. **WASM Support**: Should we design for future `wasm32-unknown-unknown` target compatibility?

---

## Implementation Phases

### Phase 1: Core Reading
- [ ] `Client` and `ClientConfig`
- [ ] `DurableStream` handle
- [ ] `ChunkIterator` with catch-up reads
- [ ] Basic error types

### Phase 2: Live Modes
- [ ] Long-poll support
- [ ] SSE parser and support
- [ ] `LiveMode::Auto` with fallback logic

### Phase 3: Writing
- [ ] `create()`, `append()`, `delete()`, `head()`
- [ ] Content-type handling

### Phase 4: Idempotent Producer
- [ ] `IdempotentProducer` with batching
- [ ] Epoch/sequence management
- [ ] Auto-claim support

### Phase 5: Polish
- [ ] Conformance test integration
- [ ] Documentation
- [ ] Examples
- [ ] Benchmarks
