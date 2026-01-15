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

```ruby
require 'durable_streams'

# Configure once at startup
DurableStreams.configure do |config|
  config.base_url = "https://streams.example.com"
  config.timeout = 30
  config.default_headers = {
    "Authorization" => -> { "Bearer #{current_token}" }  # Dynamic headers supported
  }
end

# Create a stream
stream = DurableStreams.create("/my-stream", content_type: :json)

# Append data
stream.append({ event: "user.created", user_id: 123 })
stream << { event: "user.updated", user_id: 123 }  # Shovel operator works too

# Read all data
stream.read.each { |msg| puts msg }
```

### Writing

```ruby
stream = DurableStreams.create("/events/orders", content_type: :json)

# Shovel operator for appends
stream << { order_id: 1, status: "created" }
stream << { order_id: 2, status: "shipped" }

# With sequence numbers for ordering
stream.append({ order_id: 3 }, seq: "123")
```

### Reading

```ruby
stream = DurableStreams.stream("/events/orders")

# Catch-up: read all existing messages
stream.each { |event| process(event) }

# With checkpointing
stream.read(offset: saved_offset).each_batch do |batch|
  batch.items.each { |event| process(event) }
  save_offset(batch.next_offset)
end
```

### Live Streaming

Subscribe to real-time updates:

```ruby
stream = DurableStreams.stream("/events")

# Long-poll mode
stream.read(live: :long_poll).each do |msg|
  process(msg)
end

# SSE mode (for JSON/text streams)
stream.read(live: :sse).each do |msg|
  puts msg
end

# Auto-detect best mode
stream.read(live: :auto).each do |msg|
  handle(msg)
end

# Lazy enumeration works with Enumerator
stream.read(live: :sse).each.lazy.take(10).to_a
```

### Batch Processing with Checkpoints

For reliable processing with resume capability:

```ruby
stream.read(offset: load_checkpoint, live: :long_poll, format: :json).each_batch do |batch|
  ActiveRecord::Base.transaction do
    batch.items.each { |item| Order.process(item) }
    save_checkpoint(batch.next_offset)
  end
end
```

### Exactly-Once Writes with Producer

For high-throughput writes with exactly-once delivery guarantees:

```ruby
# Block form (recommended - auto flush/close)
DurableStreams::Producer.open(
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

## Configuration

### Global Configuration

```ruby
DurableStreams.configure do |config|
  config.base_url = ENV["DURABLE_STREAMS_URL"]
  config.default_content_type = :json
  config.timeout = 30
  config.retry_policy = DurableStreams::RetryPolicy.new(
    max_retries: 5,
    initial_delay: 0.1,
    max_delay: 30.0
  )
  config.default_headers = {
    "Authorization" => -> { "Bearer #{refresh_token}" }  # Callable for dynamic values
  }
end

# Reset to defaults (useful in tests)
DurableStreams.reset_configuration!

# Optional logger
DurableStreams.logger = Logger.new($stdout)
```

### Isolated Contexts

For multi-tenant or testing scenarios:

```ruby
# Create an isolated context with different settings
staging = DurableStreams.new_context do |config|
  config.base_url = "https://staging.example.com"
end

# Use the context explicitly
stream = DurableStreams::Stream.new("/events", context: staging)
```

## API Reference

### Module Methods

```ruby
DurableStreams.configure { |config| ... }           # Configure globally
DurableStreams.reset_configuration!                  # Reset to defaults
DurableStreams.new_context { |config| ... }         # Create isolated context

DurableStreams.stream("/path")                       # Get Stream handle
DurableStreams.create("/path", content_type: :json)  # Create stream on server
DurableStreams.append("/path", data)                 # One-shot append
DurableStreams.read("/path", offset: "-1")           # One-shot read
```

### Stream

```ruby
# Create stream handle
stream = DurableStreams.stream("/events")
stream = DurableStreams::Stream.new("/events")
stream = DurableStreams::Stream.new("https://full-url.com/events")  # Full URL works too

# Factory methods
stream = DurableStreams::Stream.create("/events", content_type: :json)  # Create on server
stream = DurableStreams::Stream.connect("/events")                       # Verify exists
DurableStreams::Stream.exists?("/events")                                # => true/false

# Metadata
stream.head                  # => HeadResult (exists, content_type, next_offset, ...)
stream.exists?               # Check if stream exists (no exception)
stream.json?                 # Check if JSON content type
stream.content_type          # Content type from last head/read

# Writing
stream.append(data, seq: nil)  # Append data, returns AppendResult with next_offset
stream.append!(data)           # Same as append (explicit sync name)
stream << data                 # Shovel operator (returns self for chaining)

# Reading
stream.each { |msg| ... }                           # Catch-up iteration (live: false)
stream.read(offset: "-1", live: false, format: :auto)  # Returns Reader
stream.read_all(offset: "-1")                       # Read all and return array

# Lifecycle
stream.create_stream(content_type:, ttl_seconds: nil, expires_at: nil)
stream.delete
stream.close  # Shutdown transport
```

### Read Options

```ruby
stream.read(
  offset: "-1",      # Starting position ("-1" = beginning)
  live: false,       # false, :auto, :long_poll, :sse
  format: :auto,     # :auto, :json, :bytes
  cursor: nil        # Server-provided cursor for continuation
)
```

| `live` Mode  | Behavior                                              |
| ------------ | ----------------------------------------------------- |
| `false`      | Return immediately when caught up (catch-up only)     |
| `:long_poll` | Wait for new data, return when available or timeout   |
| `:sse`       | Server-Sent Events stream with automatic reconnection |
| `:auto`      | SSE for JSON/text streams, long-poll otherwise        |

| `format` | Behavior                                |
| -------- | --------------------------------------- |
| `:auto`  | Detect from Content-Type header         |
| `:json`  | Force JSON parsing (returns JsonReader) |
| `:bytes` | Force raw bytes (returns ByteReader)    |

### Readers

```ruby
reader = stream.read(format: :json)

reader.each { |msg| ... }           # Iterate individual messages
reader.each_batch { |batch| ... }   # Iterate batches with metadata
reader.to_a                         # Collect all messages

# Enumerator support (each returns Enumerator when no block given)
reader.each.lazy.take(5).to_a

reader.next_offset   # Current position (for checkpointing)
reader.cursor        # Server-provided cursor
reader.up_to_date?   # Whether caught up to head
reader.status        # HTTP status of last response
reader.close         # Stop iteration
```

### Producer

```ruby
# Block form (recommended - auto-closes)
DurableStreams::Producer.open(url: "https://...", producer_id: "...") do |producer|
  producer << data  # Shovel operator
end

# Manual form
producer = DurableStreams::Producer.new(
  url: "https://...",
  producer_id: "unique-id",
  epoch: 0,                    # Increment on restart to reclaim
  auto_claim: false,           # Auto-bump epoch on 403
  max_batch_bytes: 1_048_576,  # 1MB default
  linger_ms: 5,                # Batch window
  max_in_flight: 5             # Concurrent batches
)

producer.append(data)      # Fire-and-forget (batched)
producer << data           # Same as append (returns self for chaining)
producer.append!(data)     # Wait for acknowledgment, returns ProducerResult
producer.flush             # Flush pending batches
producer.close             # Flush and close
producer.closed?           # Check if closed

producer.epoch  # Current epoch
producer.seq    # Current sequence number
```

### Client (Optional)

For cases where you need explicit connection management:

```ruby
# Block form (auto-closes)
DurableStreams::Client.open(base_url: "https://...") do |client|
  stream = client.stream("/events")
  # ...
end

# Manual form
client = DurableStreams::Client.new(
  base_url: "https://...",
  headers: {},
  timeout: 30
)
client.close  # Shutdown connections
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

## Testing

The gem provides testing utilities for mocking in tests:

```ruby
require 'durable_streams/testing'

RSpec.describe "My feature" do
  before do
    DurableStreams::Testing.install!
    DurableStreams::Testing.clear!
  end

  after do
    DurableStreams::Testing.reset!
  end

  it "appends to stream" do
    # Use the mock transport
    DurableStreams::Testing.mock_transport.seed_stream("/events", [])

    stream = DurableStreams.create("/events", content_type: :json)
    stream.append({ event: "test" })

    # Verify
    messages = DurableStreams::Testing.messages_for("/events")
    expect(messages).to include({ "event" => "test" })
  end
end
```

## Thread Safety

- **Configuration**: Thread-safe after freeze (configure at startup)
- **Stream**: Create one per thread for concurrent reads
- **Producer**: Thread-safe, uses mutex for state management
- **Readers**: Single-threaded (create new reader per thread)

## Use Cases

### AI Token Streaming

Stream LLM tokens with resume capability:

```ruby
# Server: stream tokens (continues even if client disconnects)
producer = DurableStreams::Producer.new(
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
stream = DurableStreams.stream("https://streams.example.com/generation/#{id}")
stream.read(offset: saved_offset, live: :sse).each do |token|
  render_token(token)
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
stream.read(offset: Checkpoint.last, live: :sse, format: :json).each_batch do |batch|
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
