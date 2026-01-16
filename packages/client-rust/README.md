# Durable Streams Rust Client

A Rust client for [Durable Streams](https://github.com/durable-streams/durable-streams) - persistent, resumable event streams over HTTP with exactly-once semantics.

## What is Durable Streams?

Durable Streams is an open protocol for real-time sync to client applications. It provides HTTP-based durable streams for streaming data reliably to any platform with offset-based resumability.

**The problem it solves:** WebSocket and SSE connections are fragile - tabs get suspended, networks flap, devices switch, pages refresh. When that happens, you either lose in-flight data or build a bespoke resume protocol. AI streaming makes this painfully visible: when the stream fails mid-generation, the product fails even if the model did the right thing.

**What you get:**

- **Refresh-safe** - Users refresh the page, switch tabs, or background the app - they pick up exactly where they left off
- **Never re-run** - Don't repeat expensive work (like LLM inference) because a client disconnected mid-stream
- **Massive fan-out** - CDN-friendly design means one origin can serve millions of concurrent viewers

## Installation

Add to your `Cargo.toml`:

```toml
[dependencies]
durable-streams = "0.1"
tokio = { version = "1", features = ["rt-multi-thread", "macros"] }
```

## Quick Start

### Reading a Stream

```rust
use durable_streams::{Client, Offset, LiveMode};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let client = Client::new();
    let stream = client.stream("http://localhost:4437/v1/stream/events");

    // Read all existing data, then tail for new data
    let mut reader = stream.read()
        .offset(Offset::Beginning)
        .live(LiveMode::Auto)  // SSE preferred, falls back to long-poll
        .build();

    while let Some(chunk) = reader.next_chunk().await? {
        println!("Data: {:?}", String::from_utf8_lossy(&chunk.data));

        // Save offset for resumption after restarts
        save_checkpoint(&chunk.next_offset.to_string());

        if chunk.up_to_date {
            println!("Caught up! Now tailing for new data...");
        }
    }

    Ok(())
}
```

### High-Throughput Writes with Producer

For high-throughput writes with exactly-once delivery guarantees, use `Producer`:

```rust
use durable_streams::{Client, CreateOptions};
use std::time::Duration;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let client = Client::new();
    let stream = client.stream("http://localhost:4437/v1/stream/events");

    // Create a JSON stream
    stream.create_with(
        CreateOptions::new().content_type("application/json")
    ).await?;

    // Create an idempotent producer with error handling
    let producer = stream.producer("my-service-1")
        .epoch(0)
        .auto_claim(true)                   // Auto-recover on restart
        .linger(Duration::from_millis(5))   // Batch for 5ms
        .max_batch_bytes(64 * 1024)         // 64KB max batch
        .content_type("application/json")   // Match stream content type
        .on_error(|err| {                     // Handle batch errors (Kafka-style)
            eprintln!("Batch failed: {}", err);
        })
        .build();

    // Fire-and-forget writes - automatically batched & pipelined
    for i in 0..1000 {
        producer.append_json(&serde_json::json!({
            "event": "user.action",
            "index": i
        }));
    }

    // Wait for all batches to complete (errors reported via on_error callback)
    producer.flush().await?;
    producer.close().await?;

    Ok(())
}
```

### Resume from Checkpoint

```rust
use durable_streams::{Client, Offset};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let client = Client::new();
    let stream = client.stream("http://localhost:4437/v1/stream/events");

    // Load saved checkpoint (e.g., from database or file)
    let saved_offset: Option<String> = load_checkpoint();

    let offset = match saved_offset {
        Some(o) => Offset::At(o),
        None => Offset::Beginning,
    };

    let mut reader = stream.read()
        .offset(offset)
        .build();

    while let Some(chunk) = reader.next_chunk().await? {
        process_data(&chunk.data);

        // Save checkpoint for resumption
        save_checkpoint(&chunk.next_offset.to_string());
    }

    Ok(())
}
```

## API Overview

### Client

```rust
// Default client (panics on error - fine for most apps)
let client = Client::new();

// With configuration (returns Result for error handling)
let client = Client::builder()
    .base_url("http://localhost:4437")
    .default_header("Authorization", "Bearer token")
    .timeout(Duration::from_secs(30))
    .header_provider(|| {
        // Called per-request for dynamic headers
        let mut headers = HeaderMap::new();
        headers.insert("X-Request-Id", uuid::Uuid::new_v4().to_string().parse().unwrap());
        headers
    })
    .build()?;  // Returns Result<Client, reqwest::Error>
```

### DurableStream

```rust
// Get a handle (no network request yet)
let stream = client.stream("http://localhost:4437/v1/stream/my-stream");

// --- Producer operations (server-side) ---

stream.create().await?;
stream.create_with(CreateOptions::new()
    .content_type("application/json")
    .ttl(Duration::from_secs(3600))
).await?;

stream.append(b"data").await?;

// --- Consumer operations (client-side) ---

let reader = stream.read()
    .offset(Offset::Beginning)
    .live(LiveMode::Auto)
    .build();

// --- Management operations ---

let head = stream.head().await?;
println!("Next offset: {:?}", head.next_offset);
println!("Content-Type: {:?}", head.content_type);

stream.delete().await?;
```

### Offset

```rust
// Start from beginning
Offset::Beginning  // Equivalent to offset=-1 in protocol

// Resume from specific position
Offset::At("abc123xyz".to_string())

// Start from current tail (only future data)
Offset::Now
```

### LiveMode

```rust
// No live tailing - stop after catching up
LiveMode::Off

// Automatic selection: SSE preferred, falls back to long-poll
LiveMode::Auto

// Explicit long-polling
LiveMode::LongPoll

// Explicit Server-Sent Events
LiveMode::Sse
```

### ChunkIterator

```rust
let mut reader = stream.read()
    .offset(Offset::Beginning)
    .live(LiveMode::Auto)
    .build();

// Iterate over chunks
while let Some(chunk) = reader.next_chunk().await? {
    // Raw data bytes
    let data: Bytes = chunk.data;

    // Next offset for checkpointing
    let offset: Offset = chunk.next_offset;

    // Whether we've caught up to the tail
    let up_to_date: bool = chunk.up_to_date;

    // Cursor for CDN request collapsing
    let cursor: Option<String> = chunk.cursor;
}

// Check state
reader.is_up_to_date();
reader.offset();

// Clean up
reader.close();
```

### Producer

```rust
let producer = stream.producer("producer-id")
    .epoch(0)                           // Starting epoch
    .auto_claim(true)                   // Auto-recover on stale epoch
    .max_batch_bytes(1024 * 1024)       // 1MB max batch
    .linger(Duration::from_millis(5))   // Batch collection time
    .max_in_flight(5)                   // Concurrent batches
    .content_type("application/json")   // Override content type
    .build();

// Fire-and-forget writes (errors handled centrally)
producer.append(b"data");
producer.append_json(&my_struct);

// Wait for all pending writes
producer.flush().await?;

// Graceful shutdown
producer.close().await?;
```

## Error Handling

```rust
use durable_streams::StreamError;

match stream.append(b"data").await {
    Ok(response) => {
        println!("Written at offset: {:?}", response.next_offset);
    }
    Err(StreamError::NotFound { url }) => {
        println!("Stream doesn't exist: {}", url);
    }
    Err(StreamError::Conflict) => {
        println!("Stream already exists with different config");
    }
    Err(StreamError::RateLimited { retry_after }) => {
        if let Some(duration) = retry_after {
            tokio::time::sleep(duration).await;
        }
    }
    Err(e) if e.is_retryable() => {
        println!("Transient error, can retry: {}", e);
    }
    Err(e) => {
        println!("Fatal error: {}", e);
    }
}
```

## Feature Flags

```toml
[dependencies]
durable-streams = { version = "0.1", default-features = false, features = ["json", "rustls"] }
```

| Feature      | Default | Description                      |
| ------------ | ------- | -------------------------------- |
| `json`       | Yes     | JSON serialization support       |
| `rustls`     | Yes     | TLS via rustls (pure Rust)       |
| `native-tls` | No      | TLS via system libraries         |
| `tracing`    | No      | Integration with `tracing` crate |

## Use Cases

### AI Token Streaming

Stream LLM responses with resume capability:

```rust
// Server: stream tokens to durable stream
let producer = stream.producer(&generation_id)
    .auto_claim(true)
    .linger(Duration::from_millis(10))
    .build();

for token in llm.stream(&prompt) {
    producer.append(token.as_bytes());
}
producer.flush().await?;
```

```rust
// Client: resume from last seen position
let mut reader = stream.read()
    .offset(Offset::At(last_seen_offset))
    .live(LiveMode::Auto)
    .build();

while let Some(chunk) = reader.next_chunk().await? {
    render_tokens(&chunk.data);
    save_checkpoint(&chunk.next_offset.to_string());
}
```

### Real-time Event Streaming

```rust
// Producer service
let producer = stream.producer("event-service")
    .auto_claim(true)
    .build();

producer.append_json(&serde_json::json!({
    "type": "user.created",
    "user_id": "123",
    "timestamp": chrono::Utc::now().to_rfc3339()
}));
```

```rust
// Consumer service
let mut reader = stream.read()
    .offset(last_processed_offset)
    .live(LiveMode::Auto)
    .build();

while let Some(chunk) = reader.next_chunk().await? {
    let events: Vec<Event> = serde_json::from_slice(&chunk.data)?;
    for event in events {
        process_event(event).await?;
    }
    commit_offset(&chunk.next_offset.to_string()).await?;
}
```

### Database Change Streaming

```rust
// Server: stream Postgres changes
let producer = stream.producer("postgres-cdc")
    .auto_claim(true)
    .build();

for change in postgres_logical_replication.changes() {
    producer.append_json(&change);
}
```

```rust
// Mobile/web client: catch up and tail
let mut reader = stream.read()
    .offset(local_sync_offset)
    .live(LiveMode::Auto)
    .build();

while let Some(chunk) = reader.next_chunk().await? {
    apply_changes_to_local_db(&chunk.data)?;
    persist_sync_offset(&chunk.next_offset.to_string())?;
}
```

## Protocol

This client implements the [Durable Streams Protocol](https://github.com/durable-streams/durable-streams/blob/main/PROTOCOL.md). Key protocol features:

- **Offset-based resumption** - Resume from any position with exactly-once semantics
- **Multiple live modes** - Long-poll and SSE for real-time tailing
- **Idempotent producers** - Exactly-once writes via producer ID, epoch, and sequence numbers
- **CDN-friendly** - Offset-based URLs enable aggressive caching and request collapsing
- **Content-type preservation** - Set at creation, preserved for all reads

## License

Apache 2.0 or MIT, at your option.

## Links

- [Durable Streams Protocol](https://github.com/durable-streams/durable-streams/blob/main/PROTOCOL.md)
- [GitHub Repository](https://github.com/durable-streams/durable-streams)
- [Announcing Durable Streams](https://electric-sql.com/blog/2025/12/09/announcing-durable-streams)
