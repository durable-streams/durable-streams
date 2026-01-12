# Ruby Client Design for Durable Streams

**Status**: Implemented
**Date**: 2026-01-09 (Design) / 2026-01-12 (Updated to match implementation)
**Author**: Claude

## Executive Summary

This document proposes a unified design for a Ruby client library for the Durable Streams protocol. The design synthesizes patterns from major streaming platforms (Kafka, Redis Streams, NATS JetStream, Pulsar, Kinesis, Pub/Sub, RabbitMQ) while adhering to Ruby idioms and the existing TypeScript/Python/Go client patterns.

---

## Research Summary

### Patterns from Streaming Platforms

| Platform           | Ruby Client                            | Key Patterns                                                                        |
| ------------------ | -------------------------------------- | ----------------------------------------------------------------------------------- |
| **Kafka**          | `rdkafka-ruby`, `ruby-kafka`           | Producer/Consumer separation, batching, factory pattern, thread-safe async producer |
| **Redis Streams**  | `redis-rb`                             | Simple method-based API (`xadd`, `xread`), blocking reads, consumer groups          |
| **NATS JetStream** | `nats-pure`                            | Context-based API (`nc.jetstream`), pull subscriptions with `fetch`, acknowledgment |
| **Pulsar**         | `pulsar-client-ruby`                   | Block-based producer/consumer patterns, sync/async modes                            |
| **Kinesis**        | `aws-sdk-kinesis`, `aws-kclrb`         | Event streams with callbacks, SubscribeToShard for streaming                        |
| **Pub/Sub**        | `google-cloud-pubsub`                  | Streaming pull with `listen`, configurable threads/streams, acknowledgment          |
| **RabbitMQ**       | `bunny`                                | Higher/lower level APIs, subscribe with blocks, prefetch control                    |
| **SSE**            | `ld-eventsource`, `server_sent_events` | Event callbacks, automatic reconnection with backoff                                |

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

    # @param url [String] Stream URL (keyword for public API consistency)
    # @param headers [Hash, Proc] Request headers
    # @param params [Hash, Proc] Query parameters
    # @param content_type [String] Content type for the stream
    # @param client [Client, nil] Parent client (optional)
    # @param batching [Boolean] Enable write batching (default: true)
    # @param on_error [Proc] Error handler callback
    def initialize(url:, headers: {}, params: {}, content_type: nil,
                   client: nil, batching: true, on_error: nil)
    end

    # --- Factory Methods (Class-level) ---

    # Create and verify stream exists
    # @param url [String] Stream URL (keyword argument for consistency)
    def self.connect(url:, **options)
      new(url: url, **options).tap(&:head)
    end

    # Create new stream on server
    # @param url [String] Stream URL (keyword argument for consistency)
    def self.create(url:, content_type:, ttl_seconds: nil,
                    expires_at: nil, body: nil, **options)
      new(url: url, content_type: content_type, **options).tap do |s|
        s.create(content_type: content_type, ttl_seconds: ttl_seconds,
                 expires_at: expires_at, body: body)
      end
    end

    # --- Metadata Operations ---

    # HEAD - Get stream metadata
    # @return [HeadResult]
    def head
    end

    # Create stream on server (PUT)
    # Note: Named `create_stream` to distinguish from Stream.create factory method
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

### 4. StreamReader Classes (JSON vs Bytes)

The protocol has distinct JSON mode (preserved message boundaries) and byte mode.
We expose this explicitly with separate reader classes to avoid type confusion:

```ruby
module DurableStreams
  # Reader for JSON streams - yields parsed Ruby objects
  # Note: No BaseReader class; common code is inline in each reader for simplicity
  class JsonReader
    include Enumerable

    attr_reader :next_offset, :cursor, :up_to_date, :status

    def initialize(stream, offset: "-1", live: :auto, cursor: nil)
      @stream = stream
      @offset = (offset.nil? || offset.to_s.empty?) ? "-1" : offset.to_s
      @live = live
      @next_offset = @offset
      @cursor = cursor
      @up_to_date = false
      @closed = false
      @status = nil  # Tracks HTTP status (useful for 204 handling)
    end

    # Cancel/close the reader
    def close
      @closed = true
    end

    def closed?
      @closed
    end

    def up_to_date?
      @up_to_date
    end

    # Iterate over individual JSON messages
    # @yield [Object] Each parsed JSON message
    def each(&block)
      return enum_for(:each) unless block_given?

      each_batch do |batch|
        batch.items.each(&block)
      end
    end

    # Iterate over batches with metadata
    # @yield [JsonBatch] Each batch with items, next_offset, cursor, up_to_date
    def each_batch(&block)
      return enum_for(:each_batch) unless block_given?

      loop do
        break if @closed
        batch = fetch_next_json_batch
        break if batch.nil?

        @next_offset = batch.next_offset
        @cursor = batch.cursor
        @up_to_date = batch.up_to_date

        yield batch

        break if @live == false && @up_to_date
      end
    end

    # Collect all messages until up_to_date
    # @return [Array]
    def to_a
      result = []
      each { |msg| result << msg }
      result
    end
    alias_method :messages, :to_a

    private

    def fetch_next_json_batch
      # HTTP fetch, parse JSON array, return JsonBatch
    end
  end

  # Reader for byte streams - yields raw chunks
  class ByteReader
    include Enumerable

    attr_reader :next_offset, :cursor, :up_to_date, :status

    def initialize(stream, offset: "-1", live: :auto, cursor: nil)
      @stream = stream
      @offset = (offset.nil? || offset.to_s.empty?) ? "-1" : offset.to_s
      @live = live
      @next_offset = @offset
      @cursor = cursor
      @up_to_date = false
      @closed = false
      @status = nil
    end

    def close
      @closed = true
    end

    def closed?
      @closed
    end

    def up_to_date?
      @up_to_date
    end

    # Iterate over byte chunks
    # @yield [ByteChunk] Each chunk with data, next_offset, cursor, up_to_date
    def each(&block)
      return enum_for(:each) unless block_given?

      loop do
        break if @closed
        chunk = fetch_next_chunk
        break if chunk.nil?

        @next_offset = chunk.next_offset
        @cursor = chunk.cursor
        @up_to_date = chunk.up_to_date

        yield chunk

        break if @live == false && @up_to_date
      end
    end

    # Accumulate all bytes until up_to_date
    # @return [String]
    def body
      chunks = []
      each { |chunk| chunks << chunk.data }
      chunks.join
    end

    # Get as text
    # @return [String]
    def text
      body.encode('UTF-8')
    end

    private

    def fetch_next_chunk
      # HTTP fetch, return ByteChunk
    end
  end
end
```

The `Stream` class provides convenience methods that return the appropriate reader:

```ruby
class Stream
  # Read JSON messages (for application/json streams)
  # @return [JsonReader]
  def read_json(offset: "-1", live: :auto, &block)
    reader = JsonReader.new(self, offset: offset, live: live)
    block_with_cleanup(reader, &block)
  end

  # Read raw bytes (for non-JSON streams)
  # @return [ByteReader]
  def read_bytes(offset: "-1", live: :auto, &block)
    reader = ByteReader.new(self, offset: offset, live: live)
    block_with_cleanup(reader, &block)
  end

  # Auto-select reader based on content_type (convenience method)
  # @return [JsonReader, ByteReader]
  def read(offset: "-1", live: :auto, &block)
    if content_type&.include?('application/json')
      read_json(offset: offset, live: live, &block)
    else
      read_bytes(offset: offset, live: live, &block)
    end
  end

  private

  def block_with_cleanup(reader, &block)
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
stream.read_json(live: false).each_batch do |batch|
  bulk_insert(batch.items)
  save_checkpoint(batch.next_offset)  # Use next_offset for checkpointing
end

# Pattern 6: Block form with automatic cleanup
stream.read(offset: "now", live: :sse) do |reader|
  reader.each { |msg| handle(msg) }
end  # reader automatically closed
```

### 5. IdempotentProducer Class

For exactly-once writes with batching. Takes a URL directly (standalone, doesn't require a Stream object):

```ruby
module DurableStreams
  class IdempotentProducer
    # @param url [String] Stream URL
    # @param producer_id [String] Stable identifier for this producer
    # @param epoch [Integer] Starting epoch (increment on restart)
    # @param auto_claim [Boolean] Auto-retry with epoch+1 on 403
    # @param max_batch_bytes [Integer] Max bytes before flush (default: 1MB)
    # @param linger_ms [Integer] Max wait before flush (default: 5ms)
    # @param max_in_flight [Integer] Concurrent batch limit (default: 5)
    # @param content_type [String] Content type for the stream
    # @param headers [Hash] Additional headers
    def initialize(
      url:,
      producer_id:,
      epoch: 0,
      auto_claim: false,
      max_batch_bytes: 1_048_576,
      linger_ms: 5,
      max_in_flight: 5,
      content_type: nil,
      headers: {}
    )
    end

    # Current epoch (may increase if auto_claim triggers)
    # Current sequence number
    attr_reader :epoch, :seq

    # Append a message (fire-and-forget, batched)
    # @param data [Object] Data to append
    # @return [void]
    def append(data)
    end

    # Append and wait for acknowledgment
    # @param data [Object] Data to append
    # @return [IdempotentAppendResult]
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
producer = DurableStreams::IdempotentProducer.new(
  url: "https://streams.example.com/orders",
  producer_id: "order-service-1",
  epoch: load_epoch_from_disk || 0
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

Field naming follows the protocol header `Stream-Next-Offset` and Go client convention.
Uses `Struct.new` with `keyword_init: true` for broader Ruby version compatibility:

```ruby
module DurableStreams
  # Protocol header constants
  STREAM_NEXT_OFFSET_HEADER = "stream-next-offset"
  STREAM_UP_TO_DATE_HEADER = "stream-up-to-date"
  STREAM_CURSOR_HEADER = "stream-cursor"
  STREAM_TTL_HEADER = "stream-ttl"
  STREAM_EXPIRES_AT_HEADER = "stream-expires-at"
  STREAM_SEQ_HEADER = "stream-seq"
  PRODUCER_ID_HEADER = "producer-id"
  PRODUCER_EPOCH_HEADER = "producer-epoch"
  PRODUCER_SEQ_HEADER = "producer-seq"
  PRODUCER_EXPECTED_SEQ_HEADER = "producer-expected-seq"
  PRODUCER_RECEIVED_SEQ_HEADER = "producer-received-seq"

  # Result from HEAD request
  # next_offset: The tail offset (position after last byte, where next append goes)
  HeadResult = Struct.new(:exists, :content_type, :next_offset, :etag, :cache_control, keyword_init: true) do
    def exists? = exists
  end

  # Result from append
  # next_offset: The new tail offset after this append (for checkpointing)
  AppendResult = Struct.new(:next_offset, :duplicate, keyword_init: true) do
    def duplicate? = duplicate || false
  end

  # A batch of JSON messages with metadata
  # next_offset: Position to resume from (pass to next read)
  JsonBatch = Struct.new(:items, :next_offset, :cursor, :up_to_date, keyword_init: true) do
    def up_to_date? = up_to_date || false
  end

  # A byte chunk (for non-JSON streams)
  # next_offset: Position to resume from (pass to next read)
  ByteChunk = Struct.new(:data, :next_offset, :cursor, :up_to_date, keyword_init: true) do
    def up_to_date? = up_to_date || false
  end

  # Result from idempotent producer append
  # Includes epoch and seq for tracking producer state
  IdempotentAppendResult = Struct.new(:next_offset, :duplicate, :epoch, :seq, keyword_init: true) do
    def duplicate? = duplicate || false
  end

  # Retry policy configuration
  RetryPolicy = Struct.new(:max_retries, :initial_delay, :max_delay, :multiplier, :retryable_statuses,
                           keyword_init: true) do
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

  # Helper: Check if content type is JSON
  def self.json_content_type?(content_type)
    return false if content_type.nil?
    normalized = content_type.split(";").first&.strip&.downcase
    normalized == "application/json"
  end

  # Helper: Check if content type supports SSE
  def self.sse_compatible?(content_type)
    return false if content_type.nil?
    normalized = content_type.split(";").first&.strip&.downcase
    normalized == "application/json" || normalized&.start_with?("text/")
  end
end
```

### 7. Error Handling

Following Ruby conventions with typed exceptions. Includes a `code` attribute for programmatic error handling:

```ruby
module DurableStreams
  # Base error class
  class Error < StandardError
    attr_reader :url, :status, :headers, :code

    def initialize(message = nil, url: nil, status: nil, headers: nil, code: nil)
      super(message)
      @url = url
      @status = status
      @headers = headers || {}
      @code = code
    end
  end

  # Stream not found (404)
  class StreamNotFoundError < Error
    def initialize(url: nil, **opts)
      super("Stream not found: #{url}", url: url, status: 404, code: "NOT_FOUND", **opts)
    end
  end

  # Stream already exists with different config (409)
  class StreamExistsError < Error
    def initialize(url: nil, **opts)
      super("Stream already exists: #{url}", url: url, status: 409, code: "CONFLICT_EXISTS", **opts)
    end
  end

  # Sequence conflict (409 with Stream-Seq)
  class SeqConflictError < Error
    def initialize(url: nil, **opts)
      super("Sequence conflict", url: url, status: 409, code: "CONFLICT_SEQ", **opts)
    end
  end

  # Content type mismatch (409)
  class ContentTypeMismatchError < Error
    def initialize(url: nil, expected: nil, actual: nil, **opts)
      super("Content type mismatch: expected #{expected}, got #{actual}",
            url: url, status: 409, code: "CONFLICT", **opts)
    end
  end

  # Producer epoch is stale (403)
  class StaleEpochError < Error
    attr_reader :current_epoch

    def initialize(message = "Stale producer epoch", current_epoch: nil, **opts)
      super(message, status: 403, code: "FORBIDDEN", **opts)
      @current_epoch = current_epoch
    end
  end

  # Producer sequence gap (409)
  class SequenceGapError < Error
    attr_reader :expected_seq, :received_seq

    def initialize(expected_seq: nil, received_seq: nil, **opts)
      super("Sequence gap: expected #{expected_seq}, got #{received_seq}",
            status: 409, code: "SEQUENCE_GAP", **opts)
      @expected_seq = expected_seq
      @received_seq = received_seq
    end
  end

  # Rate limited (429)
  class RateLimitedError < Error
    def initialize(url: nil, **opts)
      super("Rate limited", url: url, status: 429, code: "RATE_LIMITED", **opts)
    end
  end

  # Bad request (400)
  class BadRequestError < Error
    def initialize(message = "Bad request", url: nil, **opts)
      super(message, url: url, status: 400, code: "BAD_REQUEST", **opts)
    end
  end

  # Network/connection error
  class ConnectionError < Error
    def initialize(message = "Connection error", **opts)
      super(message, code: "NETWORK_ERROR", **opts)
    end
  end

  # Timeout error
  class TimeoutError < Error
    def initialize(message = "Request timeout", **opts)
      super(message, code: "TIMEOUT", **opts)
    end
  end

  # Reader already consumed
  class AlreadyConsumedError < Error
    def initialize(**opts)
      super("Reader already consumed", code: "ALREADY_CONSUMED", **opts)
    end
  end

  # SSE not supported for this content type
  class SSENotSupportedError < Error
    def initialize(content_type: nil, **opts)
      super("SSE not supported for content type: #{content_type}",
            status: 400, code: "SSE_NOT_SUPPORTED", **opts)
    end
  end

  # Generic fetch error for unexpected statuses
  class FetchError < Error
    def initialize(message = "Fetch error", url: nil, status: nil, **opts)
      super(message, url: url, status: status, code: "UNEXPECTED_STATUS", **opts)
    end
  end

  # Helper: Map HTTP status to appropriate error
  def self.error_from_status(status, url: nil, body: nil, headers: nil, operation: nil)
    case status
    when 400 then BadRequestError.new(body || "Bad request", url: url, headers: headers)
    when 403 then StaleEpochError.new(body || "Forbidden", url: url, headers: headers)
    when 404 then StreamNotFoundError.new(url: url, headers: headers)
    when 409
      if headers&.key?("stream-seq")
        SeqConflictError.new(url: url, headers: headers)
      else
        StreamExistsError.new(url: url, headers: headers)
      end
    when 429 then RateLimitedError.new(url: url, headers: headers)
    else FetchError.new(body || "HTTP #{status}", url: url, status: status, headers: headers)
    end
  end
end
```

### 8. Configuration

Simplified global configuration (only logger is configurable globally):

```ruby
module DurableStreams
  class << self
    # Global logger instance
    attr_accessor :logger
  end

  # Default: no logging
  self.logger = nil
end

# Usage
DurableStreams.logger = Logger.new($stdout)
DurableStreams.logger = Rails.logger
```

Note: Per-request configuration (timeout, headers, etc.) is handled at the Client/Stream level rather than globally.

---

## HTTP Transport Considerations

### Implementation: `net/http` (stdlib)

The implementation uses Ruby's built-in `net/http` for zero dependencies:

- Thread-local connection pooling for efficiency
- Streaming response support for SSE
- No external gem dependencies

```ruby
# No additional gems required - uses Ruby stdlib
require 'net/http'
require 'json'
```

### SSE Implementation

**Production Requirements:** A production SSE parser must handle:

- Both `\n\n` and `\r\n\r\n` event delimiters (and mixed newlines)
- Comment lines starting with `:`
- Empty `data:` lines
- Large event payloads without O(n²) buffer growth
- Connection drop + automatic reconnect with exponential backoff
- Cursor/offset resumption on reconnect (critical for Durable Streams)

The sketch below is **simplified for illustration**. For production, consider:

- Using `ld-eventsource` gem (LaunchDarkly's mature SSE client)
- Or implementing full [W3C SSE spec](https://html.spec.whatwg.org/multipage/server-sent-events.html)

```ruby
module DurableStreams
  class SSEReader
    def initialize(url, headers:, params:, retry_policy: RetryPolicy.default)
      @url = url
      @headers = headers
      @params = params
      @retry_policy = retry_policy
      @buffer = ""
      @last_offset = nil  # For reconnection
      @last_cursor = nil
    end

    def each_event
      return enum_for(:each_event) unless block_given?

      with_reconnection do
        open_connection do |response|
          response.body.each do |chunk|
            @buffer << chunk
            parse_events.each do |event|
              # Track offset/cursor from control events for reconnection
              if event[:type] == 'control'
                control = JSON.parse(event[:data])
                @last_offset = control['streamNextOffset']
                @last_cursor = control['streamCursor']
              end
              yield event
            end
          end
        end
      end
    end

    private

    def with_reconnection
      attempts = 0
      begin
        yield
      rescue IOError, Errno::ECONNRESET, Net::ReadTimeout => e
        attempts += 1
        raise if attempts > @retry_policy.max_retries

        delay = [@retry_policy.initial_delay * (@retry_policy.multiplier ** attempts),
                 @retry_policy.max_delay].min
        sleep(delay)
        @buffer = ""  # Clear buffer on reconnect
        retry
      end
    end

    def build_reconnect_url
      # On reconnect, use last known offset and cursor
      uri = URI.parse(@url)
      params = URI.decode_www_form(uri.query || "").to_h
      params['offset'] = @last_offset if @last_offset
      params['cursor'] = @last_cursor if @last_cursor
      uri.query = URI.encode_www_form(params)
      uri.to_s
    end

    def parse_events
      events = []
      # Handle both \n\n and \r\n\r\n delimiters
      while (idx = @buffer.index(/\r?\n\r?\n/))
        match = @buffer.match(/\r?\n\r?\n/)
        raw = @buffer.slice!(0, idx + match[0].length)
        event = parse_sse_event(raw)
        events << event if event
      end
      events
    end

    def parse_sse_event(raw)
      event_type = nil
      data_lines = []

      raw.each_line do |line|
        line = line.chomp
        next if line.start_with?(':')  # Comment line
        next if line.empty?

        case line
        when /^event:\s*(.*)$/
          event_type = $1
        when /^data:\s?(.*)$/
          data_lines << $1
        when /^data$/
          data_lines << ""  # Empty data line
        end
      end

      return nil if data_lines.empty?
      { type: event_type, data: data_lines.join("\n") }
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

| Feature         | TypeScript                    | Python                        | Go                    | Ruby (Proposed)           |
| --------------- | ----------------------------- | ----------------------------- | --------------------- | ------------------------- |
| Stream handle   | `DurableStream`               | `DurableStream`               | `Stream`              | `Stream`                  |
| Factory methods | Static methods                | Class methods                 | `Client.Stream()`     | Both                      |
| Read API        | `stream()` → `StreamResponse` | `stream()` → `StreamResponse` | `Read()` → `Iterator` | `read()` → `StreamReader` |
| Iteration       | `subscribeJson()` callbacks   | `iter_json()`                 | `for range`           | `each` block / Enumerable |
| Batching        | Auto (fastq)                  | Auto (threading)              | Manual                | Auto (threading)          |
| SSE             | Built-in                      | Built-in                      | Built-in              | Built-in                  |
| Async           | Native (Promise)              | `async`/`await`               | Goroutines            | Threads / Fibers          |

---

## File Structure

```
packages/client-rb/
├── lib/
│   └── durable_streams/
│       ├── version.rb
│       ├── client.rb
│       ├── stream.rb
│       ├── json_reader.rb       # JSON stream reader
│       ├── byte_reader.rb       # Byte stream reader
│       ├── idempotent_producer.rb
│       ├── sse_reader.rb
│       ├── http/
│       │   └── transport.rb     # net/http-based transport
│       ├── types.rb
│       └── errors.rb
├── lib/durable_streams.rb       # Main entry point
├── conformance_adapter.rb       # For conformance test suite
├── durable_streams.gemspec
├── Gemfile
├── design.md                    # This file
└── README.md
```

---

## Gemspec Dependencies

```ruby
Gem::Specification.new do |spec|
  spec.name          = "durable_streams"
  spec.version       = DurableStreams::VERSION
  spec.summary       = "Ruby client for Durable Streams protocol"

  # Uses Struct (not Data.define) for broader compatibility
  spec.required_ruby_version = ">= 3.0.0"

  # No runtime dependencies - uses net/http from stdlib

  # Testing
  spec.add_development_dependency "rspec", "~> 3.12"
  spec.add_development_dependency "webmock", "~> 3.18"
end
```

---

## Complete Usage Example

```ruby
require 'durable_streams'

# Configure logger (optional)
DurableStreams.logger = Logger.new($stdout)

# Create a client with auth
client = DurableStreams::Client.new(
  base_url: "https://streams.example.com",
  headers: {
    "Authorization" => -> { "Bearer #{fetch_current_token}" }
  }
)

# Create a stream
stream = client.create("/events/orders", content_type: "application/json")

# Write with idempotent producer (takes URL directly)
producer = DurableStreams::IdempotentProducer.new(
  url: "https://streams.example.com/events/orders",
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
stream.read_json(offset: load_checkpoint, live: :long_poll).each_batch do |batch|
  ActiveRecord::Base.transaction do
    batch.items.each { |item| Order.process(item) }
    Checkpoint.update(stream.url, batch.next_offset)  # next_offset for resumption
  end
end

# Cleanup
producer.close
client.close
```

---

## Implementation Decisions

The following questions from the original design have been resolved:

1. **Async support**: Left to users (works with threads, compatible with fiber schedulers)

2. **HTTP client**: `net/http` (zero dependencies, stdlib only)

3. **Thread safety**: Thread-local connection pooling in Transport; readers are single-threaded

4. **Naming**: `JsonReader` and `ByteReader` (explicit type distinction)

5. **Rails integration**: Not included in core library (can be added as separate gem)

6. **Fiber scheduler**: Compatible but not explicitly supported

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
