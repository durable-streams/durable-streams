# Durable Streams Ruby Client

A Ruby client for [Durable Streams](https://github.com/durable-streams/durable-streams)—the open protocol for real-time sync to client applications.

## What is Durable Streams?

Durable Streams provides HTTP-based durable streams for streaming data reliably with offset-based resumability. Think "append-only log as a service" that works everywhere HTTP works.

**The problem it solves:** WebSocket and SSE connections are fragile—tabs get suspended, networks flap, pages refresh. When that happens, you either lose in-flight data or build a bespoke resume protocol. Durable Streams gives you:

- **Refresh-safe** - Users refresh the page or background the app—they pick up exactly where they left off
- **Never re-run** - Don't repeat expensive work (like LLM inference) because a client disconnected
- **Share links** - A stream is a URL. Multiple viewers can watch the same stream together
- **CDN-friendly** - Offset-based URLs enable aggressive caching for massive fan-out

## Installation

Add to your Gemfile:

```ruby
gem 'durable_streams'
```

Or install directly:

```bash
gem install durable_streams
```

**Requirements:** Ruby 3.1+

## Quick Start

### One-shot operations

```ruby
require 'durable_streams'

# Create a stream
stream = DurableStreams.create(
  url: "https://streams.example.com/my-stream",
  content_type: "application/json"
)

# Append data
DurableStreams.append(
  url: "https://streams.example.com/my-stream",
  data: { event: "user.created", user_id: 123 }
)

# Read all data
messages = DurableStreams.read(
  url: "https://streams.example.com/my-stream",
  offset: "-1"  # from beginning
)
```

### Writing (Producer)

```ruby
DurableStreams::Client.open(base_url: "https://streams.example.com") do |client|
  stream = client.create("/events/orders", content_type: "application/json")

  # Shovel operator for appends
  stream << { order_id: 1, status: "created" }
  stream << { order_id: 2, status: "shipped" }
end
```

### Reading (Consumer)

```ruby
stream = DurableStreams.connect(url: "https://streams.example.com/events/orders")

# Catch-up: read all existing messages
stream.each { |event| process(event) }

# Or with checkpointing
stream.read_json(offset: saved_offset).each_batch do |batch|
  batch.items.each { |event| process(event) }
  save_offset(batch.next_offset)
end
```

### Live Streaming

Subscribe to real-time updates with familiar Ruby iteration:

```ruby
stream = DurableStreams::Stream.connect(url: "https://streams.example.com/events")

# Block-based iteration (recommended)
stream.subscribe(offset: "now", live: :sse) do |message|
  puts "Received: #{message}"
end

# Or use Enumerable methods
stream.read(live: :long_poll).each do |msg|
  process(msg)
end

# Lazy enumeration
stream.read(live: :sse).lazy.take(10).each { |m| puts m }
```

### Batch Processing with Checkpoints

For reliable processing with resume capability:

```ruby
stream.read_json(offset: load_checkpoint, live: :long_poll).each_batch do |batch|
  ActiveRecord::Base.transaction do
    batch.items.each { |item| Order.process(item) }
    save_checkpoint(batch.next_offset)  # Save position for resume
  end
end
```

### Exactly-Once Writes with IdempotentProducer

For high-throughput writes with exactly-once delivery guarantees:

```ruby
# Block form (recommended - auto flush/close)
DurableStreams::IdempotentProducer.open(
  url: "https://streams.example.com/events",
  producer_id: "order-service-#{Process.pid}",
  epoch: 0,
  auto_claim: true  # Auto-recover from epoch conflicts
) do |producer|
  # Fire-and-forget writes with shovel operator
  1000.times { |i| producer << { order_id: i, status: "created" } }
end  # auto flush/close
```

**How it works:** The producer maintains `(producer_id, epoch, seq)` state. If another process claims the same producer_id with a higher epoch, your writes will be rejected with a 403—preventing duplicate writes during failover.

## API Reference

### Module Methods

```ruby
DurableStreams.create(url:, content_type:, headers: {})  # Create stream
DurableStreams.connect(url:, headers: {})                 # Connect to existing
DurableStreams.append(url:, data:, headers: {})           # One-shot append
DurableStreams.read(url:, offset: "-1", headers: {})      # One-shot read
```

### Client

```ruby
# Block form (recommended - auto-closes)
DurableStreams::Client.open(base_url: "https://...") do |client|
  stream = client.stream("/events")
  # ...
end # auto-closes

# Manual form
client = DurableStreams::Client.new(
  base_url: "https://...",   # Optional base URL
  headers: {},               # Default headers (can be Proc for dynamic values)
  params: {},                # Default query params
  timeout: 30                # Request timeout in seconds
)

client.stream(url)           # Get a Stream handle
client.connect(url)          # Get handle and verify exists
client.create(url, **opts)   # Create stream and return handle
client.close                 # Close connections
```

### Stream

```ruby
stream = DurableStreams::Stream.connect(url: "https://...")

# Metadata
stream.head                  # => HeadResult (exists, content_type, next_offset, ...)
stream.exists?               # Check if stream exists (no exception)
stream.json?                 # Check if JSON content type
stream.content_type          # Content type from last head/read

# Class method for existence check
DurableStreams::Stream.exists?(url: "https://...")  # => true/false

# Writing
stream.append(data, seq: nil)  # Append data, returns AppendResult with next_offset
stream << data                 # Fire-and-forget (returns self, no offset - use append if you need it)

# Reading (Stream includes Enumerable)
stream.each { |msg| ... }                  # Catch-up iteration (offset: "-1", live: false)
stream.read(offset: "-1", live: :auto)     # Returns JsonReader or ByteReader
stream.read_json(offset: "-1", live: :sse) # Force JSON reader
stream.read_bytes(offset: "-1")            # Force byte reader
stream.read_all(offset: "-1")              # Read all and return array
stream.subscribe(offset:, live:) { |msg| } # Live streaming with full control

# Lifecycle
stream.create_stream(content_type:, ttl_seconds: nil, expires_at: nil)
stream.delete
```

### Readers

Both `JsonReader` and `ByteReader` include `Enumerable`:

```ruby
reader = stream.read_json(live: :long_poll)

reader.each { |msg| ... }           # Iterate individual messages
reader.each_batch { |batch| ... }   # Iterate batches with metadata
reader.to_a                         # Collect all messages
reader.lazy.take(5)                 # Lazy enumeration

reader.next_offset   # Current position (for checkpointing)
reader.cursor        # Server-provided cursor
reader.up_to_date?   # Whether caught up to head
reader.close         # Stop iteration
```

### IdempotentProducer

```ruby
# Block form (recommended - auto-closes)
DurableStreams::IdempotentProducer.open(url: "https://...", producer_id: "...") do |producer|
  producer << data  # Shovel operator
end

# Manual form
producer = DurableStreams::IdempotentProducer.new(
  url: "https://...",
  producer_id: "unique-id",
  epoch: 0,                    # Increment on restart to reclaim
  auto_claim: false,           # Auto-bump epoch on 403
  max_batch_bytes: 1_048_576,  # 1MB default
  linger_ms: 5,                # Batch window
  max_in_flight: 5             # Concurrent batches
)

producer.append(data)      # Fire-and-forget (batched)
producer << data           # Same as append (returns self, no ack - use append_sync if you need it)
producer.append_sync(data) # Wait for acknowledgment, returns IdempotentAppendResult
producer.flush             # Flush pending batches
producer.close             # Flush and close
producer.closed?           # Check if closed

producer.epoch  # Current epoch
producer.seq    # Current sequence number
```

### Data Types

```ruby
HeadResult      # exists, content_type, next_offset, etag, cache_control
AppendResult    # next_offset, duplicate?
JsonBatch       # items, next_offset, cursor, up_to_date?
ByteChunk       # data, next_offset, cursor, up_to_date?
```

### Errors

All errors inherit from `DurableStreams::Error` with `url`, `status`, `headers`, and `code` attributes:

```ruby
StreamNotFoundError      # 404 - Stream doesn't exist
StreamExistsError        # 409 - Stream already exists with different config
SeqConflictError         # 409 - Sequence number conflict
ContentTypeMismatchError # 409 - Wrong content type
StaleEpochError          # 403 - Producer epoch is stale (has current_epoch)
SequenceGapError         # 409 - Producer sequence gap
RateLimitedError         # 429 - Rate limited
BadRequestError          # 400 - Invalid request
ConnectionError          # Network error
TimeoutError             # Request timeout
SSENotSupportedError     # SSE not supported for content type
FetchError               # Other HTTP errors
AlreadyConsumedError     # Reader already consumed
ClosedError              # Producer has been closed
```

## Live Modes

The `live` parameter controls how reads behave when caught up:

| Mode         | Behavior                                              |
| ------------ | ----------------------------------------------------- |
| `false`      | Return immediately when caught up (catch-up only)     |
| `:long_poll` | Wait for new data, return when available or timeout   |
| `:sse`       | Server-Sent Events stream with automatic reconnection |
| `:auto`      | SSE for JSON/text streams, long-poll otherwise        |

## Thread Safety

- **Client**: Thread-safe, uses thread-local connection pools
- **Stream**: Create one per thread for concurrent reads
- **IdempotentProducer**: Thread-safe, uses mutex for state management
- **Readers**: Single-threaded (create new reader per thread)

## Configuration

```ruby
# Global logger (optional)
DurableStreams.logger = Logger.new($stdout)
DurableStreams.logger = Rails.logger

# Per-client configuration via constructor options
client = DurableStreams::Client.new(
  timeout: 60,
  headers: { "Authorization" => -> { "Bearer #{refresh_token}" } }
)
```

## Use Cases

### AI Token Streaming

Stream LLM tokens with resume capability:

```ruby
# Server: stream tokens (continues even if client disconnects)
producer = DurableStreams::IdempotentProducer.new(
  url: "https://streams.example.com/generation/#{id}",
  producer_id: id,
  auto_claim: true
)

llm.stream(prompt).each do |token|
  producer.append(token)
end
producer.flush
producer.close

# Client: resume from last position
stream.read(offset: saved_offset, live: :sse).each do |token|
  render_token(token)
  save_offset(stream.next_offset)
end
```

### Database Sync

Stream changes to Rails clients:

```ruby
# Server
db.changes.each do |change|
  stream.append(change)
end

# Client
stream.read_json(offset: Checkpoint.last, live: :sse).each_batch do |batch|
  ActiveRecord::Base.transaction do
    batch.items.each { |change| apply_change(change) }
    Checkpoint.update!(offset: batch.next_offset)
  end
end
```

### Event Sourcing

Build event-sourced systems:

```ruby
# Append events
stream.append({ type: "OrderCreated", order_id: "123" })
stream.append({ type: "OrderPaid", order_id: "123" })

# Replay from beginning
events = stream.read_all(offset: "-1")
state = events.reduce(initial_state) { |s, e| apply_event(s, e) }
```

## Protocol

See the [Protocol Specification](https://github.com/durable-streams/durable-streams/blob/main/PROTOCOL.md) for details on:

- HTTP API (`PUT`, `POST`, `GET`, `DELETE`, `HEAD`)
- Offset semantics
- Idempotent producer headers
- JSON mode vs byte mode
- CDN caching behavior

## Contributing

Bug reports and pull requests welcome at https://github.com/durable-streams/durable-streams

## License

MIT - see [LICENSE](https://github.com/durable-streams/durable-streams/blob/main/LICENSE)
