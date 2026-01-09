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
///
/// **Important**: Retries are only safe for idempotent operations:
/// - GET/HEAD requests: Always safe to retry
/// - POST append with IdempotentProducer: Safe (has Producer-Id/Epoch/Seq)
/// - Plain POST append: NOT safe to retry (can cause duplicates)
///
/// The client enforces this by using different retry policies for different
/// operation types. See `RetryPolicy` for the operation-aware configuration.
#[derive(Clone, Debug)]
pub struct RetryConfig {
    pub initial_backoff: Duration,
    pub max_backoff: Duration,
    pub multiplier: f64,
    pub max_retries: u32,
    /// Jitter mode for backoff delays (prevents thundering herd)
    pub jitter: JitterMode,
}

/// Jitter mode for retry backoff (following AWS SDK patterns)
#[derive(Clone, Debug, Default)]
pub enum JitterMode {
    /// No jitter - use exact backoff delay
    None,
    /// Full jitter: random delay between 0 and calculated backoff
    #[default]
    Full,
    /// Equal jitter: half fixed + half random
    Equal,
    /// Decorrelated jitter (AWS recommended)
    Decorrelated,
}

impl Default for RetryConfig {
    fn default() -> Self {
        Self {
            initial_backoff: Duration::from_millis(100),
            max_backoff: Duration::from_secs(60),
            multiplier: 1.3,
            max_retries: 10,
            jitter: JitterMode::Full,
        }
    }
}

/// Operation-aware retry policy
///
/// This enum ensures retries are only applied to idempotent operations,
/// preventing data duplication from retrying non-idempotent writes.
#[derive(Clone, Debug)]
pub enum RetryPolicy {
    /// Retry on 5xx, 429, network errors (safe for GET/HEAD)
    ReadPolicy(RetryConfig),
    /// No automatic retries (for plain POST append)
    NoRetry,
    /// Retry with idempotent producer semantics (Producer-Id/Epoch/Seq present)
    IdempotentWritePolicy(RetryConfig),
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
///
/// ## `LiveMode::Auto` Fallback Behavior
///
/// When `Auto` is selected, the client attempts live modes in this order:
///
/// 1. **SSE first**: If the stream content type is `text/*` or `application/json`,
///    attempt SSE connection
///
/// 2. **Fallback to long-poll**: SSE falls back to long-poll when:
///    - Content type doesn't support SSE (e.g., `application/octet-stream`)
///    - Server returns 400 Bad Request for SSE (unsupported)
///    - SSE connections fail repeatedly with short durations (< 1s), indicating
///      proxy buffering or server misconfiguration
///
/// 3. **Retry tracking**: After 3 consecutive short SSE connections, the client
///    switches to long-poll for the remainder of the session
///
/// The fallback is transparent to the user - iteration continues seamlessly.
#[derive(Clone, Debug, Default)]
pub enum LiveMode {
    /// No live tailing - stop after catching up (first `up_to_date`)
    #[default]
    Off,
    /// Automatic selection: SSE preferred, falls back to long-poll on failure.
    /// See "LiveMode::Auto Fallback Behavior" above.
    Auto,
    /// Explicit long-polling for live updates
    LongPoll,
    /// Explicit Server-Sent Events for live updates.
    /// Returns `StreamError::SseNotSupported` if content type is incompatible.
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

    /// Cancel and clean up
    pub async fn close(self) -> Result<(), StreamError> { ... }
}

// NOTE: ChunkIterator implements `futures::Stream` but does NOT have an
// inherent `next()` method. This avoids method resolution confusion where
// an inherent method would shadow `StreamExt::next()`.
//
// Users should use `StreamExt::next()` from the futures crate:
//   use futures::StreamExt;
//   while let Some(chunk) = iterator.next().await { ... }

/// A chunk of data from the stream.
///
/// ## Chunk Semantics
///
/// A `Chunk` represents **one unit of data delivery** from the stream, but its
/// exact meaning depends on the read mode:
///
/// | Mode | What `Chunk.data` contains |
/// |------|----------------------------|
/// | **Catch-up (no live)** | One HTTP response body (may be partial if server chunks) |
/// | **Long-poll** | One HTTP response body (data that arrived during the poll) |
/// | **SSE** | One SSE `data` event payload (server batches events ~60s) |
///
/// For `application/json` streams, `data` contains:
/// - **Catch-up/Long-poll**: Raw JSON array bytes, e.g., `[{"a":1},{"a":2}]`
/// - **SSE**: Raw JSON array bytes from the SSE data event
///
/// Use `ReaderBuilder::json::<T>()` to get a stream of individual deserialized
/// items rather than raw `Chunk` bytes.
///
/// ## `up_to_date` Semantics
///
/// The `up_to_date` flag indicates we've reached the stream's tail:
///
/// | Mode | `up_to_date == true` means |
/// |------|---------------------------|
/// | **Catch-up** | Response included all available data; no more to fetch |
/// | **Long-poll** | Server timed out with no new data (204 response) |
/// | **SSE** | Control event included `upToDate: true` |
///
/// When `live == LiveMode::Off`, iteration stops after the first `up_to_date`.
/// When live tailing, iteration continues waiting for new data.
#[derive(Debug)]
pub struct Chunk {
    /// The raw data bytes for this chunk.
    /// For JSON streams, this is the JSON array (e.g., `[{...}, {...}]`).
    /// Use `json::<T>()` on the reader for parsed items.
    pub data: Bytes,
    /// Next offset to read from (for resumption/checkpointing)
    pub next_offset: Offset,
    /// Whether this chunk represents the current tail of the stream.
    /// See "up_to_date Semantics" above.
    pub up_to_date: bool,
    /// Cursor for CDN request collapsing (echo in subsequent requests)
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
    // =========================================================================
    // Fire-and-Forget API (High Throughput)
    // =========================================================================
    //
    // Use these for maximum throughput when you don't need per-message acks.
    // Errors are reported via the `on_error` callback in ProducerBuilder.

    /// Append data (fire-and-forget, batched internally)
    /// Returns immediately - data queued for sending.
    ///
    /// Errors during send are reported via `on_error` callback.
    /// Returns `Err` only for local failures (closed, queue full).
    pub fn append(&self, data: impl Into<Bytes>) -> Result<(), ProducerError> { ... }

    /// Append JSON data (fire-and-forget)
    pub fn append_json<T: Serialize>(&self, data: &T) -> Result<(), ProducerError> { ... }

    // =========================================================================
    // Acknowledged API (Correctness-Critical)
    // =========================================================================
    //
    // Use these when you need confirmation that data was durably written.
    // Lower throughput than fire-and-forget, but provides per-message receipts.

    /// Append data and wait for server acknowledgment.
    ///
    /// Returns a receipt with the offset after the data was written.
    /// Use this for correctness-critical writes where you need confirmation.
    ///
    /// Note: Still benefits from batching - if multiple `append_acked` calls
    /// are pending, they may be batched together, but each gets its own receipt.
    pub async fn append_acked(&self, data: impl Into<Bytes>) -> Result<AppendReceipt, ProducerError> { ... }

    /// Append JSON data and wait for server acknowledgment.
    pub async fn append_json_acked<T: Serialize>(&self, data: &T) -> Result<AppendReceipt, ProducerError> { ... }

    // =========================================================================
    // Lifecycle
    // =========================================================================

    /// Flush all pending data and wait for acknowledgment
    pub async fn flush(&self) -> Result<(), ProducerError> { ... }

    /// Close the producer gracefully
    pub async fn close(self) -> Result<(), ProducerError> { ... }
}

/// Receipt from an acknowledged append operation
#[derive(Debug, Clone)]
pub struct AppendReceipt {
    /// The offset after this message was appended
    pub next_offset: Offset,
    /// Whether this was a duplicate (idempotent success, data already existed)
    pub duplicate: bool,
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
/// Internal HTTP client wrapper with operation-aware retry logic
struct HttpClient {
    inner: reqwest::Client,
    read_retry_config: RetryConfig,  // For GET/HEAD
    header_provider: Option<Box<dyn Fn() -> HeaderMap + Send + Sync>>,
}

impl HttpClient {
    /// Execute a read request (GET/HEAD) with automatic retries
    async fn read(&self, req: Request) -> Result<Response, StreamError> {
        self.execute_with_retry(req, &self.read_retry_config).await
    }

    /// Execute a write request (POST) WITHOUT automatic retries.
    ///
    /// Plain appends are NOT safe to retry - if the server commits the write
    /// but we don't receive the response (network error), retrying would
    /// duplicate data. Use IdempotentProducer for safe retries on writes.
    async fn write(&self, req: Request) -> Result<Response, StreamError> {
        self.execute_once(req).await
    }

    /// Execute a write request with idempotent producer headers.
    /// Safe to retry because Producer-Id/Epoch/Seq enable deduplication.
    async fn idempotent_write(&self, req: Request, config: &RetryConfig) -> Result<Response, StreamError> {
        self.execute_with_retry(req, config).await
    }

    async fn execute_with_retry(&self, req: Request, config: &RetryConfig) -> Result<Response, StreamError> {
        let mut attempts = 0;
        let mut delay = config.initial_backoff;

        loop {
            let req = self.prepare_request(req.try_clone().ok_or(...)?)?;

            match self.inner.execute(req).await {
                Ok(resp) if resp.status().is_success() => return Ok(resp),
                Ok(resp) => {
                    let err = StreamError::from_response(resp).await;
                    if !err.is_retryable() || attempts >= config.max_retries {
                        return Err(err);
                    }
                }
                Err(e) => {
                    if attempts >= config.max_retries {
                        return Err(StreamError::Network(e));
                    }
                }
            }

            // Apply jitter to prevent thundering herd
            let jittered_delay = apply_jitter(delay, &config.jitter);
            tokio::time::sleep(jittered_delay).await;

            delay = std::cmp::min(
                Duration::from_secs_f64(delay.as_secs_f64() * config.multiplier),
                config.max_backoff,
            );
            attempts += 1;
        }
    }
}

/// Apply jitter to a backoff delay
fn apply_jitter(delay: Duration, mode: &JitterMode) -> Duration {
    use rand::Rng;
    let mut rng = rand::thread_rng();

    match mode {
        JitterMode::None => delay,
        JitterMode::Full => {
            // Random between 0 and delay
            Duration::from_secs_f64(rng.gen::<f64>() * delay.as_secs_f64())
        }
        JitterMode::Equal => {
            // Half fixed + half random
            let half = delay.as_secs_f64() / 2.0;
            Duration::from_secs_f64(half + rng.gen::<f64>() * half)
        }
        JitterMode::Decorrelated => {
            // AWS-style: min(max_delay, random_between(base, delay * 3))
            let base = delay.as_secs_f64() / 3.0;
            let upper = delay.as_secs_f64() * 3.0;
            Duration::from_secs_f64(base + rng.gen::<f64>() * (upper - base))
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

# Random (for jitter)
rand = "0.8"

# JSON (optional)
serde = { version = "1", features = ["derive"], optional = true }
serde_json = { version = "1", optional = true }

# Datetime (consider using std::time::SystemTime to reduce deps)
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

## Design Decisions (from Review)

The following decisions were made based on external review feedback:

### 1. Operation-Aware Retry Policy (Safety Critical)

**Problem**: Automatic retries on non-idempotent POST appends can cause data duplication
if the server commits but the client doesn't receive the response.

**Decision**: The HTTP layer distinguishes between:
- `read()` - GET/HEAD with automatic retries (safe)
- `write()` - POST without retries (prevents duplicates)
- `idempotent_write()` - POST with Producer headers, safe to retry

### 2. No Inherent `next()` Method on ChunkIterator

**Problem**: Defining both inherent `async fn next()` and implementing `futures::Stream`
causes method resolution confusion (inherent wins, shadows `StreamExt::next`).

**Decision**: Only implement `Stream` trait. Users use `StreamExt::next()` from futures crate.

### 3. Jitter in Backoff Configuration

**Problem**: Without jitter, synchronized reconnects create thundering herd effects.

**Decision**: Added `JitterMode` enum with Full (default), Equal, Decorrelated, and None options.

### 4. Acknowledged Append API

**Problem**: Fire-and-forget only doesn't serve correctness-critical use cases that need
per-message confirmation.

**Decision**: Added `append_acked()` and `append_json_acked()` that return `AppendReceipt`
with offset and duplicate flag.

### 5. Documented Chunk and up_to_date Semantics

**Problem**: The meaning of `Chunk` and `up_to_date` varies by read mode but wasn't documented.

**Decision**: Added detailed doc comments explaining semantics in each mode (catch-up, long-poll, SSE).

### 6. Documented LiveMode::Auto Fallback Behavior

**Problem**: How Auto mode handles SSE failures wasn't specified.

**Decision**: Documented the fallback sequence: SSE first → long-poll on failure/unsupported.

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
