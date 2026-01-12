# DurableStreams Elixir Client

Elixir client library for [Durable Streams](https://github.com/durable-streams/durable-streams) - persistent, resumable event streams over HTTP.

## What is Durable Streams?

Durable Streams is a protocol for append-only event streams over HTTP. Think of it as "Kafka-lite" that works anywhere HTTP works:

- **Persistent**: Data survives server restarts
- **Resumable**: Clients can disconnect and resume from where they left off using offsets
- **Exactly-once writes**: Idempotent producer pattern prevents duplicates on retry
- **Real-time**: Long-poll and SSE modes for live streaming
- **Simple**: Just HTTP - works with any language, through any proxy/CDN

## Installation

Add `durable_streams` to your list of dependencies in `mix.exs`:

```elixir
def deps do
  [
    {:durable_streams, "~> 0.1.0"}
  ]
end
```

## Quick Start

```elixir
# Create a client pointing to your Durable Streams server
client = DurableStreams.Client.new("http://localhost:8080")

# Get a stream handle (no network I/O yet)
stream = DurableStreams.Client.stream(client, "/events")

# Create the stream on the server
{:ok, stream} = DurableStreams.Stream.create(stream, content_type: "application/json")

# Append some events
{:ok, _} = DurableStreams.Stream.append(stream, ~s({"type": "user_created", "id": 1}))
{:ok, _} = DurableStreams.Stream.append(stream, ~s({"type": "user_updated", "id": 1}))

# Read all events
{:ok, chunks} = DurableStreams.Stream.read_all(stream)
IO.inspect(chunks, label: "Events")
```

## Core Concepts

### Streams

A stream is an append-only log identified by a URL path. Data written to a stream is immutable and ordered.

```elixir
# Streams are just handles - lightweight and copyable
stream = DurableStreams.Client.stream(client, "/my-app/events")

# Create with options
{:ok, stream} = DurableStreams.Stream.create(stream,
  content_type: "application/json",
  ttl_seconds: 86400  # Auto-delete after 24 hours
)
```

### Offsets

Every piece of data in a stream has an offset - an opaque string that marks its position. Use offsets to resume reading:

```elixir
# Read and get the next offset
{:ok, chunk} = DurableStreams.Stream.read(stream, offset: "-1")
IO.puts("Data: #{chunk.data}")
IO.puts("Next offset: #{chunk.next_offset}")

# Later, resume from where we left off
{:ok, chunk} = DurableStreams.Stream.read(stream, offset: saved_offset)
```

### Live Modes

For real-time updates, use long-poll or SSE:

```elixir
# Long-poll: waits up to timeout for new data
{:ok, chunk} = DurableStreams.Stream.read(stream,
  offset: last_offset,
  live: :long_poll,
  timeout: 30_000
)

# SSE: server-sent events for continuous streaming
{:ok, chunk} = DurableStreams.Stream.read(stream,
  offset: last_offset,
  live: :sse
)
```

## Long-Running Consumer

For production use, the `Consumer` GenServer handles:

- Automatic reconnection with exponential backoff
- Offset tracking for resumability
- Callback-based processing

```elixir
defmodule MyApp.EventConsumer do
  @behaviour DurableStreams.Consumer

  @impl true
  def init(_args) do
    {:ok, %{processed: 0}}
  end

  @impl true
  def handle_batch(batch, state) do
    # batch.data - the raw binary data
    # batch.next_offset - offset for checkpointing
    # batch.up_to_date - true when caught up

    events = Jason.decode!(batch.data)
    Enum.each(events, &process_event/1)

    # Persist offset for crash recovery
    MyApp.Repo.save_offset(batch.next_offset)

    {:ok, %{state | processed: state.processed + 1}}
  end

  @impl true
  def handle_error(error, state) do
    Logger.warning("Consumer error: #{inspect(error)}")
    {:reconnect, state}  # Will retry with backoff
  end

  defp process_event(event), do: IO.inspect(event)
end

# Start the consumer
{:ok, consumer} = DurableStreams.Consumer.start_link(
  stream: stream,
  callback: {MyApp.EventConsumer, []},
  live: :long_poll,
  offset: MyApp.Repo.load_offset() || "-1"
)

# Add to your supervision tree for crash recovery
children = [
  {DurableStreams.Consumer,
    stream: stream,
    callback: {MyApp.EventConsumer, []},
    live: :long_poll,
    offset: "-1",
    name: MyApp.EventConsumer}
]
```

### Consumer Options

| Option          | Default      | Description                              |
| --------------- | ------------ | ---------------------------------------- |
| `:stream`       | required     | Stream handle from `Client.stream/2`     |
| `:callback`     | required     | `{Module, args}` tuple                   |
| `:live`         | `:long_poll` | Live mode: `false`, `:long_poll`, `:sse` |
| `:offset`       | `"-1"`       | Starting offset                          |
| `:backoff_base` | `1000`       | Initial backoff delay (ms)               |
| `:backoff_max`  | `30000`      | Maximum backoff delay (ms)               |

## Idempotent Writer

For exactly-once write semantics, use the `Writer` GenServer:

```elixir
# Start a writer with a stable producer ID
{:ok, writer} = DurableStreams.Writer.start_link(
  stream: stream,
  producer_id: "order-service-#{node()}",
  epoch: 0
)

# Fire-and-forget writes (batched automatically)
:ok = DurableStreams.Writer.append(writer, ~s({"order_id": 1, "status": "created"}))
:ok = DurableStreams.Writer.append(writer, ~s({"order_id": 1, "status": "paid"}))
:ok = DurableStreams.Writer.append(writer, ~s({"order_id": 1, "status": "shipped"}))

# Wait for all writes to be confirmed
:ok = DurableStreams.Writer.flush(writer)

# Graceful shutdown
:ok = DurableStreams.Writer.close(writer)
```

### Exactly-Once Semantics

The Writer uses `(producer_id, epoch, seq)` tuples to guarantee exactly-once delivery:

- **producer_id**: Stable identifier for this producer
- **epoch**: Incremented on restart to fence zombie writers
- **seq**: Auto-incrementing sequence number

If a network failure causes a retry, the server deduplicates using these headers.

### Epoch Management

When restarting a producer, increment the epoch to fence any zombie processes:

```elixir
# Load last known epoch from your database
last_epoch = MyApp.Repo.get_producer_epoch("order-service") || -1

{:ok, writer} = DurableStreams.Writer.start_link(
  stream: stream,
  producer_id: "order-service",
  epoch: last_epoch + 1
)

# Persist the new epoch
MyApp.Repo.save_producer_epoch("order-service", last_epoch + 1)
```

Or use auto-claim for simpler deployments:

```elixir
{:ok, writer} = DurableStreams.Writer.start_link(
  stream: stream,
  producer_id: "order-service",
  auto_claim: true  # Automatically bump epoch on 403
)
```

### Writer Options

| Option             | Default  | Description                |
| ------------------ | -------- | -------------------------- |
| `:stream`          | required | Stream handle              |
| `:producer_id`     | required | Stable producer identifier |
| `:epoch`           | `0`      | Starting epoch             |
| `:auto_claim`      | `false`  | Auto-bump epoch on 403     |
| `:max_batch_size`  | `100`    | Max items per batch        |
| `:max_batch_bytes` | `1MB`    | Max bytes per batch        |
| `:linger_ms`       | `5`      | Max wait before sending    |
| `:on_error`        | `nil`    | Error callback function    |

## Low-Level API

For simple scripts or custom implementations, use the Stream module directly:

```elixir
# Create
{:ok, stream} = DurableStreams.Stream.create(stream, content_type: "text/plain")

# Append
{:ok, result} = DurableStreams.Stream.append(stream, "Hello, World!")

# Read
{:ok, chunk} = DurableStreams.Stream.read(stream, offset: "-1")

# Read all
{:ok, chunks} = DurableStreams.Stream.read_all(stream)

# Head (get metadata)
{:ok, meta} = DurableStreams.Stream.head(stream)

# Delete
:ok = DurableStreams.Stream.delete(stream)
```

### Manual Idempotent Appends

```elixir
{:ok, _} = DurableStreams.Stream.append(stream, data,
  producer_id: "my-producer",
  producer_epoch: 0,
  producer_seq: 0
)

# Increment seq for each message
{:ok, _} = DurableStreams.Stream.append(stream, data2,
  producer_id: "my-producer",
  producer_epoch: 0,
  producer_seq: 1
)
```

## Error Handling

All operations return `{:ok, result}` or `{:error, reason}`:

```elixir
case DurableStreams.Stream.read(stream, offset: offset) do
  {:ok, chunk} ->
    process(chunk.data)

  {:error, :not_found} ->
    Logger.error("Stream does not exist")

  {:error, {:gone, earliest_offset}} ->
    # Data was compacted, jump to earliest available
    Logger.warning("Offset expired, jumping to #{earliest_offset}")
    read_from(earliest_offset)

  {:error, {:stale_epoch, server_epoch}} ->
    # Another producer took over
    Logger.error("Fenced by epoch #{server_epoch}")

  {:error, reason} ->
    Logger.error("Unexpected error: #{inspect(reason)}")
end
```

## Architecture

```
┌──────────────────────────────────────────────┐
│  Consumer (GenServer)  │  Writer (GenServer)  │  ← OTP patterns
├──────────────────────────────────────────────┤
│              Stream (CRUD ops)               │  ← Functional core
├──────────────────────────────────────────────┤
│                   HTTP                       │  ← Erlang :httpc
└──────────────────────────────────────────────┘
```

- **Consumer**: Long-running process for reading with auto-reconnect
- **Writer**: Fire-and-forget producer with batching and exactly-once
- **Stream**: Pure functions for individual operations
- **HTTP**: Low-level HTTP client using Erlang's built-in `:httpc`

## Limitations

### SSE (Server-Sent Events)

SSE support is limited due to `:httpc` not supporting streaming responses. SSE reads will timeout and return available data. For real-time streaming, prefer `:long_poll` mode.

### No External Dependencies

This library uses only Erlang's built-in `:httpc` module and Elixir's native JSON (1.18+) or Jason. No Finch, no connection pooling.

## Development

```bash
# Compile
mix compile

# Run tests
mix test

# Build conformance adapter
mix escript.build
```

## License

MIT License - see the [LICENSE](../../LICENSE) file for details.
