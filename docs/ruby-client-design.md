# Ruby Client Design for Durable Streams

**Status**: Draft for Review
**Date**: 2026-01-09
**Author**: Claude

## Executive Summary

This document proposes a unified design for a Ruby client library for the Durable Streams protocol. The design synthesizes patterns from major streaming platforms (Kafka, Redis Streams, NATS JetStream, Pulsar, Kinesis, Pub/Sub, RabbitMQ) while adhering to Ruby idioms and the existing TypeScript/Python/Go client patterns.

---

## Research Summary

### Patterns from Streaming Platforms

| Platform | Ruby Client | Key Patterns |
|----------|-------------|--------------|
| **Kafka** | `rdkafka-ruby`, `ruby-kafka` | Producer/Consumer separation, batching, factory pattern, thread-safe async producer |
| **Redis Streams** | `redis-rb` | Simple method-based API (`xadd`, `xread`), blocking reads, consumer groups |
| **NATS JetStream** | `nats-pure` | Context-based API (`nc.jetstream`), pull subscriptions with `fetch`, acknowledgment |
| **Pulsar** | `pulsar-client-ruby` | Block-based producer/consumer patterns, sync/async modes |
| **Kinesis** | `aws-sdk-kinesis`, `aws-kclrb` | Event streams with callbacks, SubscribeToShard for streaming |
| **Pub/Sub** | `google-cloud-pubsub` | Streaming pull with `listen`, configurable threads/streams, acknowledgment |
| **RabbitMQ** | `bunny` | Higher/lower level APIs, subscribe with blocks, prefetch control |
| **SSE** | `ld-eventsource`, `server_sent_events` | Event callbacks, automatic reconnection with backoff |

### Common Ruby Patterns Identified

1. **Block-based iteration** - `each`, `subscribe` with blocks for push consumption
2. **Enumerable mixing** - Collections implement `each` and include `Enumerable`
3. **Factory pattern** - Client creates handles/producers via methods
4. **Sync/Async duality** - Synchronous and asynchronous variants of the same API
5. **Context managers** - `begin/ensure` for resource cleanup
6. **Callable headers/params** - Procs/lambdas for dynamic values

---

## Design Goals

1. **Ruby-idiomatic API** - Use blocks, `Enumerable`, and Ruby conventions
2. **Consistency with existing clients** - Mirror TypeScript/Python/Go patterns where sensible
3. **Sync-first with async option** - Synchronous by default (Ruby tradition), async for performance
4. **Thread-safe** - Safe for use across threads when needed
5. **Minimal dependencies** - Only essential gems (HTTP client, JSON)
6. **Testable** - Easy to mock and test

---

## Proposed Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     DurableStreams                          │
│  (Top-level module with convenience methods)                │
└─────────────────────────────────────────────────────────────┘
                              │
          ┌───────────────────┼───────────────────┐
          ▼                   ▼                   ▼
┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐
│     Client      │  │     Stream      │  │  IdempotentProducer
│  (Connection    │  │  (Read/Write    │  │  (Exactly-once   │
│   pooling)      │  │   handle)       │  │   producer)      │
└─────────────────┘  └─────────────────┘  └─────────────────┘
          │                   │
          │          ┌────────┴────────┐
          │          ▼                 ▼
          │  ┌─────────────┐   ┌─────────────┐
          │  │ StreamReader│   │ StreamWriter│
          │  │ (Iterator)  │   │ (Batching)  │
          │  └─────────────┘   └─────────────┘
          │
          ▼
┌─────────────────────────────────────────────────────────────┐
│                    HTTP Transport                            │
│  (Connection pooling, retry, SSE support)                   │
└─────────────────────────────────────────────────────────────┘
```

---

## API Design

### 1. Module-Level Convenience Methods

```ruby
require 'durable_streams'

# Quick stream creation
stream = DurableStreams.create(
  url: "https://streams.example.com/my-stream",
  content_type: "application/json",
  headers: { "Authorization" => "Bearer #{token}" }
)

# Quick stream connection
stream = DurableStreams.connect(url: "https://streams.example.com/my-stream")

# One-shot append (creates client internally)
DurableStreams.append(
  url: "https://streams.example.com/my-stream",
  data: { event: "user_signup", user_id: 123 }
)

# One-shot read (returns array)
messages = DurableStreams.read(
  url: "https://streams.example.com/my-stream",
  offset: "-1"  # from beginning
)
```

### 2. Client Class (Connection Pool)

Following the Go client pattern, a `Client` manages HTTP connections:

```ruby
module DurableStreams
  class Client
    # @param base_url [String] Optional base URL for relative paths
    # @param headers [Hash, Proc] Default headers (static or callable)
    # @param params [Hash, Proc] Default query params (static or callable)
    # @param timeout [Numeric] Request timeout in seconds
    # @param retry_policy [RetryPolicy] Custom retry configuration
    # @param http_client [Object] Custom HTTP client (default: internal)
    def initialize(
      base_url: nil,
      headers: {},
      params: {},
      timeout: 30,
      retry_policy: RetryPolicy.default,
      http_client: nil
    )
    end

    # Get a Stream handle for the given URL
    # @param url [String] Full URL or path (if base_url set)
    # @return [Stream]
    def stream(url)
      Stream.new(url, client: self)
    end

    # Shortcut: create stream and connect
    def connect(url, **options)
      stream(url).tap(&:head)
    end

    # Shortcut: create new stream on server
    def create(url, **options)
      stream(url).tap { |s| s.create(**options) }
    end

    # Close all connections
    def close
    end
  end
end
```

**Usage:**

```ruby
# Create a reusable client
client = DurableStreams::Client.new(
  base_url: "https://streams.example.com",
  headers: { "Authorization" => -> { "Bearer #{refresh_token}" } },
  timeout: 60
)

# Get stream handles
chat_stream = client.stream("/chat/room-1")
events_stream = client.stream("/events/user-123")

# Always close when done
client.close
```

### 3. Stream Class (Handle)

The core read/write handle, following the Python client pattern:

```ruby
module DurableStreams
  class Stream
    attr_reader :url, :content_type

    # @param url [String] Stream URL
    # @param headers [Hash, Proc] Request headers
    # @param params [Hash, Proc] Query parameters
    # @param content_type [String] Content type for the stream
    # @param client [Client, nil] Parent client (optional)
    # @param batching [Boolean] Enable write batching (default: true)
    # @param on_error [Proc] Error handler callback
    def initialize(url, headers: {}, params: {}, content_type: nil,
                   client: nil, batching: true, on_error: nil)
    end

    # --- Factory Methods (Class-level) ---

    # Create and verify stream exists
    def self.connect(url, **options)
      new(url, **options).tap(&:head)
    end

    # Create new stream on server
    def self.create(url, content_type:, ttl_seconds: nil,
                    expires_at: nil, body: nil, **options)
      new(url, content_type: content_type, **options).tap do |s|
        s.create_stream(content_type: content_type, ttl_seconds: ttl_seconds,
                        expires_at: expires_at, body: body)
      end
    end

    # --- Metadata Operations ---

    # HEAD - Get stream metadata
    # @return [HeadResult]
    def head
    end

    # Create stream on server (PUT)
    def create_stream(content_type: nil, ttl_seconds: nil,
                      expires_at: nil, body: nil)
    end

    # Delete stream (DELETE)
    def delete
    end

    # --- Write Operations ---

    # Append data to stream
    # @param data [Object] Data to append (JSON-serializable for JSON streams)
    # @param seq [String] Optional sequence number for ordering
    # @return [AppendResult]
    def append(data, seq: nil)
    end

    # Append with streaming body
    # @param source [IO, Enumerator] Streaming source
    def append_stream(source, seq: nil)
    end

    # --- Read Operations ---

    # Start a read session
    # @param offset [String] Starting offset (default: "-1" for beginning)
    # @param live [Symbol, false] Live mode (:long_poll, :sse, :auto, false)
    # @return [StreamReader]
    def read(offset: "-1", live: :auto, &block)
      reader = StreamReader.new(self, offset: offset, live: live)
      if block_given?
        begin
          yield reader
        ensure
          reader.close
        end
      else
        reader
      end
    end

    # Convenience: Read all current data (catch-up only)
    # @return [Array] All messages from offset to current end
    def read_all(offset: "-1")
      read(offset: offset, live: false).to_a
    end

    # Convenience: Subscribe to live updates with a block
    # @yield [message] Each message as it arrives
    def subscribe(offset: "-1", live: :auto, &block)
      read(offset: offset, live: live).each(&block)
    end

    # Resource cleanup
    def close
    end
  end
end
```

### 4. StreamReader Class (Enumerable Iterator)

The key Ruby-idiomatic feature - an `Enumerable` reader:

```ruby
module DurableStreams
  class StreamReader
    include Enumerable

    attr_reader :offset, :cursor, :up_to_date

    # @param stream [Stream] Parent stream handle
    # @param offset [String] Starting offset
    # @param live [Symbol, false] Live mode
    def initialize(stream, offset: "-1", live: :auto)
    end

    # --- Enumerable Interface ---

    # Iterate over messages/batches
    # For JSON streams: yields individual parsed objects
    # For byte streams: yields ByteChunk objects
    # @yield [Object] Each message
    def each(&block)
      return enum_for(:each) unless block_given?

      loop do
        batch = fetch_next_batch
        break if batch.nil?

        batch.items.each(&block)

        break if @live == false && @up_to_date
      end
    end

    # Iterate over batches with metadata
    # @yield [Batch] Each batch with offset, cursor, up_to_date
    def each_batch(&block)
      return enum_for(:each_batch) unless block_given?

      loop do
        batch = fetch_next_batch
        break if batch.nil?

        yield batch

        break if @live == false && @up_to_date
      end
    end

    # --- Accumulating Methods ---

    # Collect all messages until up_to_date (for catch-up)
    # @return [Array]
    def to_a
      result = []
      each { |msg| result << msg }
      result
    end
    alias_method :messages, :to_a

    # Get raw bytes (for byte streams)
    # @return [String]
    def body
      chunks = []
      each_batch { |batch| chunks << batch.data }
      chunks.join
    end

    # Get as text
    # @return [String]
    def text
      body.encode('UTF-8')
    end

    # --- Lifecycle ---

    # Cancel/close the reader
    def close
    end

    # Check if reader is closed
    def closed?
    end

    private

    def fetch_next_batch
      # HTTP fetch with appropriate mode (catch-up, long-poll, SSE)
    end
  end
end
```

**Usage Examples:**

```ruby
stream = DurableStreams::Stream.connect(url: "https://...")

# Pattern 1: Block iteration (recommended for live)
stream.subscribe do |message|
  puts "Received: #{message}"
end

# Pattern 2: Enumerable methods
stream.read(offset: "-1", live: false).each do |msg|
  process(msg)
end

# Pattern 3: Collect all (catch-up)
messages = stream.read_all
messages.each { |m| puts m }

# Pattern 4: Lazy enumeration with Enumerator
reader = stream.read(live: :long_poll)
enum = reader.lazy.take(10)
enum.each { |m| puts m }
reader.close

# Pattern 5: Batch iteration for bulk processing
stream.read(live: false).each_batch do |batch|
  bulk_insert(batch.items)
  save_checkpoint(batch.offset)
end

# Pattern 6: Block form with automatic cleanup
stream.read(offset: "now", live: :sse) do |reader|
  reader.each { |msg| handle(msg) }
end  # reader automatically closed
```

### 5. IdempotentProducer Class

For exactly-once writes with batching:

```ruby
module DurableStreams
  class IdempotentProducer
    # @param stream [Stream] Target stream
    # @param producer_id [String] Stable identifier for this producer
    # @param epoch [Integer] Starting epoch (increment on restart)
    # @param auto_claim [Boolean] Auto-retry with epoch+1 on 403
    # @param max_batch_bytes [Integer] Max bytes before flush
    # @param linger_ms [Integer] Max wait before flush
    # @param max_in_flight [Integer] Concurrent batch limit
    # @param on_error [Proc] Error callback for async errors
    def initialize(
      stream,
      producer_id:,
      epoch: 0,
      auto_claim: false,
      max_batch_bytes: 1_048_576,
      linger_ms: 5,
      max_in_flight: 5,
      on_error: nil
    )
    end

    # Current epoch (may increase if auto_claim triggers)
    attr_reader :epoch

    # Append a message (fire-and-forget, batched)
    # @param data [Object] Data to append
    # @return [void]
    def append(data)
    end

    # Append and wait for acknowledgment
    # @param data [Object] Data to append
    # @return [AppendResult]
    def append_sync(data)
    end

    # Flush all pending batches
    # @return [void]
    def flush
    end

    # Close the producer, flushing pending data
    def close
    end
  end
end
```

**Usage:**

```ruby
stream = DurableStreams::Stream.connect(url: "https://...")

producer = DurableStreams::IdempotentProducer.new(
  stream,
  producer_id: "order-service-1",
  epoch: load_epoch_from_disk || 0,
  on_error: ->(err) { logger.error("Producer error: #{err}") }
)

# Fire-and-forget (batched internally)
1000.times do |i|
  producer.append({ order_id: i, status: "created" })
end

# Ensure all data is written
producer.flush
producer.close
```

### 6. Data Types

```ruby
module DurableStreams
  # Result from HEAD request
  HeadResult = Data.define(:exists, :content_type, :offset, :etag, :cache_control)

  # Result from append
  AppendResult = Data.define(:offset, :duplicate) do
    def duplicate? = duplicate
  end

  # A batch of messages with metadata
  Batch = Data.define(:items, :offset, :cursor, :up_to_date) do
    def up_to_date? = up_to_date
  end

  # A byte chunk (for non-JSON streams)
  ByteChunk = Data.define(:data, :offset, :cursor, :up_to_date)

  # Retry policy configuration
  RetryPolicy = Data.define(
    :max_retries,
    :initial_delay,
    :max_delay,
    :multiplier,
    :retryable_statuses
  ) do
    def self.default
      new(
        max_retries: 5,
        initial_delay: 0.1,
        max_delay: 30.0,
        multiplier: 2.0,
        retryable_statuses: [429, 500, 502, 503, 504]
      )
    end
  end
end
```

### 7. Error Handling

Following Ruby conventions with typed exceptions:

```ruby
module DurableStreams
  # Base error class
  class Error < StandardError
    attr_reader :url, :status, :headers

    def initialize(message, url: nil, status: nil, headers: nil)
      super(message)
      @url = url
      @status = status
      @headers = headers
    end
  end

  # Stream not found (404)
  class StreamNotFoundError < Error; end

  # Stream already exists with different config (409)
  class StreamExistsError < Error; end

  # Sequence conflict (409 with Stream-Seq)
  class SeqConflictError < Error; end

  # Content type mismatch (409)
  class ContentTypeMismatchError < Error; end

  # Producer epoch is stale (403)
  class StaleEpochError < Error
    attr_reader :current_epoch

    def initialize(message, current_epoch:, **opts)
      super(message, **opts)
      @current_epoch = current_epoch
    end
  end

  # Producer sequence gap (409)
  class SequenceGapError < Error
    attr_reader :expected_seq, :received_seq
  end

  # Rate limited (429)
  class RateLimitedError < Error; end

  # Bad request (400)
  class BadRequestError < Error; end

  # Network/connection error
  class ConnectionError < Error; end

  # Reader already consumed
  class AlreadyConsumedError < Error; end
end
```

### 8. Configuration

Global and per-request configuration:

```ruby
module DurableStreams
  # Global configuration
  class << self
    attr_accessor :default_timeout
    attr_accessor :default_retry_policy
    attr_accessor :logger
    attr_accessor :http_adapter  # :net_http, :httpx, :faraday

    def configure
      yield self
    end
  end

  # Defaults
  self.default_timeout = 30
  self.default_retry_policy = RetryPolicy.default
  self.logger = Logger.new($stdout, level: Logger::WARN)
  self.http_adapter = :net_http
end

# Usage
DurableStreams.configure do |config|
  config.default_timeout = 60
  config.logger = Rails.logger
  config.http_adapter = :httpx  # Use httpx for HTTP/2 support
end
```

---

## HTTP Transport Considerations

### Recommended: `httpx` gem

The `httpx` gem provides:
- HTTP/2 support (important for SSE multiplexing)
- Connection pooling
- Streaming responses
- Thread-safe by default

```ruby
# In Gemfile
gem 'httpx'

# Or fall back to net/http for zero dependencies
```

### SSE Implementation

```ruby
module DurableStreams
  class SSEReader
    def initialize(url, headers:, params:)
      @url = url
      @headers = headers
      @params = params
      @buffer = ""
    end

    def each_event
      return enum_for(:each_event) unless block_given?

      open_connection do |response|
        response.body.each do |chunk|
          @buffer << chunk
          parse_events.each { |event| yield event }
        end
      end
    end

    private

    def parse_events
      events = []
      while (idx = @buffer.index("\n\n"))
        raw = @buffer.slice!(0, idx + 2)
        events << parse_sse_event(raw)
      end
      events.compact
    end

    def parse_sse_event(raw)
      event_type = nil
      data_lines = []

      raw.each_line do |line|
        case line
        when /^event:\s*(.+)/
          event_type = $1.strip
        when /^data:\s*(.+)/
          data_lines << $1
        end
      end

      { type: event_type, data: data_lines.join("\n") } unless data_lines.empty?
    end
  end
end
```

---

## Threading Model

### Default: Synchronous

Most Ruby applications prefer synchronous I/O (especially Rails):

```ruby
# Synchronous by default
stream.read.each do |msg|
  # Blocks until message arrives
  process(msg)
end
```

### Optional: Async with Threads

For background consumption:

```ruby
# Background thread reader
reader = stream.read(live: :long_poll)

thread = Thread.new do
  reader.each do |msg|
    queue.push(msg)
  end
end

# Later...
reader.close  # Signals thread to stop
thread.join
```

### Optional: Async with Fiber Scheduler (Ruby 3.0+)

For applications using `Async` gem:

```ruby
require 'async'

Async do
  stream.read(live: :sse).each do |msg|
    # Non-blocking in async context
    handle(msg)
  end
end
```

---

## Comparison with Existing Clients

| Feature | TypeScript | Python | Go | Ruby (Proposed) |
|---------|------------|--------|-----|-----------------|
| Stream handle | `DurableStream` | `DurableStream` | `Stream` | `Stream` |
| Factory methods | Static methods | Class methods | `Client.Stream()` | Both |
| Read API | `stream()` → `StreamResponse` | `stream()` → `StreamResponse` | `Read()` → `Iterator` | `read()` → `StreamReader` |
| Iteration | `subscribeJson()` callbacks | `iter_json()` | `for range` | `each` block / Enumerable |
| Batching | Auto (fastq) | Auto (threading) | Manual | Auto (threading) |
| SSE | Built-in | Built-in | Built-in | Built-in |
| Async | Native (Promise) | `async`/`await` | Goroutines | Threads / Fibers |

---

## File Structure

```
packages/client-rb/
├── lib/
│   └── durable_streams/
│       ├── version.rb
│       ├── client.rb
│       ├── stream.rb
│       ├── stream_reader.rb
│       ├── stream_writer.rb
│       ├── idempotent_producer.rb
│       ├── sse_reader.rb
│       ├── http/
│       │   ├── transport.rb
│       │   ├── net_http_adapter.rb
│       │   └── httpx_adapter.rb
│       ├── types.rb
│       └── errors.rb
├── lib/durable_streams.rb       # Main entry point
├── spec/
│   ├── spec_helper.rb
│   ├── stream_spec.rb
│   ├── stream_reader_spec.rb
│   └── ...
├── durable_streams.gemspec
├── Gemfile
└── README.md
```

---

## Gemspec Dependencies

```ruby
Gem::Specification.new do |spec|
  spec.name          = "durable_streams"
  spec.version       = DurableStreams::VERSION
  spec.summary       = "Ruby client for Durable Streams protocol"

  spec.required_ruby_version = ">= 3.1.0"

  # No required dependencies (uses net/http by default)

  # Optional for better performance
  spec.add_development_dependency "httpx", "~> 1.0"

  # Testing
  spec.add_development_dependency "rspec", "~> 3.12"
  spec.add_development_dependency "webmock", "~> 3.18"
end
```

---

## Complete Usage Example

```ruby
require 'durable_streams'

# Configure globally
DurableStreams.configure do |config|
  config.logger = Logger.new($stdout)
end

# Create a client with auth
client = DurableStreams::Client.new(
  base_url: "https://streams.example.com",
  headers: {
    "Authorization" => -> { "Bearer #{fetch_current_token}" }
  }
)

# Create a stream
stream = client.create("/events/orders", content_type: "application/json")

# Write with idempotent producer
producer = DurableStreams::IdempotentProducer.new(
  stream,
  producer_id: "order-service-#{Process.pid}",
  epoch: 0
)

# Produce events
10.times do |i|
  producer.append({ order_id: i, event: "created", timestamp: Time.now.iso8601 })
end
producer.flush

# Read all current events
events = stream.read_all
puts "Found #{events.length} events"

# Subscribe to live updates
Thread.new do
  stream.subscribe(offset: "now", live: :sse) do |event|
    puts "New event: #{event}"
  end
end

# Batch processing with checkpoints
stream.read(offset: load_checkpoint, live: :long_poll).each_batch do |batch|
  ActiveRecord::Base.transaction do
    batch.items.each { |item| Order.process(item) }
    Checkpoint.update(stream.url, batch.offset)
  end
end

# Cleanup
producer.close
client.close
```

---

## Open Questions for Review

1. **Async support**: Should we support `Async` gem natively, or leave it to users?

2. **HTTP client**: Default to `net/http` (zero deps) or `httpx` (better features)?

3. **Thread safety**: Should `Stream` be thread-safe, or require one per thread?

4. **Naming**: `StreamReader` vs `StreamIterator` vs `StreamSession`?

5. **Rails integration**: Should we provide ActiveJob adapter or ActionCable integration?

6. **Fiber scheduler**: Ruby 3.0+ has native fiber scheduler - worth supporting?

---

## References

### Research Sources

- [ruby-kafka gem](https://github.com/zendesk/ruby-kafka)
- [rdkafka-ruby](https://github.com/karafka/rdkafka-ruby)
- [redis-rb Streams](https://github.com/redis/redis-rb/blob/master/lib/redis/commands/streams.rb)
- [nats-pure JetStream](https://github.com/nats-io/nats-pure.rb)
- [Pulsar Ruby clients](https://github.com/apache/pulsar-client-ruby)
- [AWS Kinesis Ruby SDK](https://docs.aws.amazon.com/sdk-for-ruby/v3/api/Aws/Kinesis.html)
- [Google Cloud Pub/Sub Ruby](https://github.com/googleapis/google-cloud-ruby/blob/main/google-cloud-pubsub/OVERVIEW.md)
- [Bunny RabbitMQ](https://github.com/ruby-amqp/bunny)
- [LaunchDarkly SSE client](https://github.com/launchdarkly/ruby-eventsource)

### Protocol

- [PROTOCOL.md](../PROTOCOL.md) - Durable Streams Protocol Specification
