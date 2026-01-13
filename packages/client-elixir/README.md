# DurableStreams Elixir Client

**Idiomatic Elixir client for [Durable Streams](https://github.com/durable-streams/durable-streams) - the open protocol for real-time sync to client applications.**

HTTP-based durable streams for streaming data reliably to web browsers, mobile apps, and native clients with offset-based resumability. Built with OTP patterns for production reliability.

## Why Durable Streams?

Modern applications frequently need ordered, durable sequences of data that can be replayed from arbitrary points and tailed in real time:

- **AI conversation streaming** - Stream LLM token responses with resume capability across reconnections
- **Database synchronization** - Stream database changes to web, mobile, and native clients
- **Collaborative editing** - Sync CRDTs and operational transforms across devices
- **Real-time updates** - Push application state to clients with guaranteed delivery
- **Event sourcing** - Build event-sourced architectures with client-side replay

WebSocket and SSE connections are easy to start, but they're fragile in practice: tabs get suspended, networks flap, devices switch, pages refresh. When that happens, you either lose in-flight data or build a bespoke backend storage and client resume protocol on top.

**Durable Streams addresses this gap.** It's a minimal HTTP-based protocol for durable, offset-based streaming. Based on 1.5 years of production use at [Electric](https://electric-sql.com/) for real-time Postgres sync, reliably delivering millions of state changes every day.

## Why Elixir?

Elixir and OTP are a natural fit for Durable Streams:

- **Supervision trees** ensure your consumers and writers restart automatically on failure
- **GenServer patterns** provide clean abstractions for stateful stream processing
- **Lightweight processes** allow thousands of concurrent stream consumers
- **Let it crash** philosophy aligns with Durable Streams' resumable design

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
# Alias as DS to avoid shadowing Elixir's Stream module
alias DurableStreams.Client
alias DurableStreams.Stream, as: DS

# Create a client pointing to your Durable Streams server
client = Client.new("http://localhost:4437")

# Pipe-friendly stream creation with bang functions
stream =
  client
  |> Client.stream("/my-app/events")
  |> DS.with_content_type("application/json")
  |> DS.create!()

# JSON convenience functions for structured data
DS.append_json!(stream, %{type: "user_created", id: 1})
DS.append_json!(stream, %{type: "user_updated", id: 1})

# Read and parse JSON in one call
{items, meta} = DS.read_json!(stream, offset: "-1")
IO.inspect(items)           # [%{"type" => "user_created", ...}, ...]
IO.puts(meta.next_offset)   # "42"
```

### Traditional Error Handling

All functions also have non-bang variants returning `{:ok, result}` / `{:error, reason}`:

```elixir
case DS.read(stream) do
  {:ok, chunk} -> process(chunk.data)
  {:error, :not_found} -> create_stream()
  {:error, reason} -> Logger.error("Failed: #{inspect(reason)}")
end
```

> **Note**: We alias `DurableStreams.Stream` as `DS` to avoid shadowing Elixir's built-in `Stream` module (lazy enumerables). Alternative aliases: `DSStream`, `DStream`, or just use the full module name.

## Use Cases

### AI Token Streaming

LLM inference is expensive. When a user's tab gets suspended or they refresh the page, you don't want to re-run the generation - you want them to pick up exactly where they left off.

```elixir
defmodule MyApp.AIStreamer do
  use DurableStreams  # Imports Client, DS, Writer, Consumer

  def stream_generation(prompt, generation_id) do
    client = Client.new(System.get_env("DURABLE_STREAMS_URL"))
    stream = Client.stream(client, "/generations/#{generation_id}")

    # Create stream for this generation
    {:ok, stream} = DS.create(stream, content_type: "text/plain")

    # Use Writer for reliable, exactly-once token delivery
    {:ok, writer} = Writer.start_link(
      stream: stream,
      producer_id: generation_id,
      epoch: 0,
      linger_ms: 10  # Batch tokens every 10ms for low latency
    )

    # Stream tokens from your LLM
    for token <- MyApp.LLM.stream(prompt) do
      Writer.append(writer, token)
    end

    # Ensure all tokens are delivered
    Writer.flush(writer)
    Writer.close(writer)
  end
end

# Client-side: resume from last seen position (refresh-safe)
{:ok, chunk} = DS.read(stream, offset: saved_offset, live: :long_poll)
# User sees tokens from where they left off, not from the beginning
```

### Database Change Streaming

Stream database changes to web and mobile clients for real-time synchronization:

```elixir
defmodule MyApp.ChangeStreamer do
  use GenServer
  use DurableStreams

  def start_link(opts) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  def init(opts) do
    client = Client.new(opts[:server_url])
    stream = Client.stream(client, "/db-changes/#{opts[:table]}")

    {:ok, writer} = Writer.start_link(
      stream: stream,
      producer_id: "db-streamer-#{node()}",
      epoch: 0
    )

    # Subscribe to database changes (e.g., from Postgres LISTEN/NOTIFY)
    MyApp.Repo.subscribe_changes(opts[:table])

    {:ok, %{writer: writer}}
  end

  def handle_info({:db_change, change}, state) do
    # Fire-and-forget - Writer batches and handles retries
    Writer.append(state.writer, JSON.encode!(change))
    {:noreply, state}
  end
end
```

### Event Sourcing

Build event-sourced systems with durable event logs:

```elixir
defmodule MyApp.OrderAggregate do
  use DurableStreams

  def replay_order(order_id) do
    client = Client.new(System.get_env("DURABLE_STREAMS_URL"))
    stream = Client.stream(client, "/orders/#{order_id}/events")

    # Read all events from beginning
    {:ok, chunks} = DS.read_all(stream, offset: "-1")

    # Replay events to rebuild state
    chunks
    |> Enum.flat_map(fn chunk ->
      chunk.data
      |> JSON.decode!()
    end)
    |> Enum.reduce(%Order{id: order_id}, &apply_event/2)
  end

  defp apply_event(%{"type" => "order_created"} = event, order) do
    %{order | status: :created, items: event["items"]}
  end

  defp apply_event(%{"type" => "order_paid"}, order) do
    %{order | status: :paid, paid_at: DateTime.utc_now()}
  end

  defp apply_event(%{"type" => "order_shipped"} = event, order) do
    %{order | status: :shipped, tracking_number: event["tracking_number"]}
  end
end
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

**Key offset facts:**

- `"-1"` means start from the beginning
- Offsets are opaque strings - never parse or construct them
- Offsets are lexicographically sortable for ordering
- Always use the `next_offset` returned by the server

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
- Supervision tree integration

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
    # batch.up_to_date - true when caught up with live stream

    events = JSON.decode!(batch.data)
    Enum.each(events, &process_event/1)

    # Persist offset for crash recovery
    MyApp.Repo.save_offset(batch.next_offset)

    {:ok, %{state | processed: state.processed + length(events)}}
  end

  @impl true
  def handle_error(error, state) do
    Logger.warning("Consumer error: #{inspect(error)}")
    {:reconnect, state}  # Will retry with exponential backoff
  end

  defp process_event(event) do
    # Your event processing logic here
    IO.inspect(event, label: "Processing")
  end
end

# Add to your supervision tree
children = [
  {DurableStreams.Consumer,
    stream: stream,
    callback: {MyApp.EventConsumer, []},
    live: :long_poll,
    offset: MyApp.Repo.load_offset() || "-1",
    name: MyApp.EventConsumer}
]

Supervisor.start_link(children, strategy: :one_for_one)
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

- **producer_id**: Stable identifier for this producer (survives restarts)
- **epoch**: Incremented on restart to fence zombie writers
- **seq**: Auto-incrementing sequence number per epoch

If a network failure causes a retry, the server deduplicates using these headers - returning 204 instead of 200 for duplicate writes.

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
  auto_claim: true  # Automatically bump epoch on 403 Forbidden
)
```

### Writer Options

| Option             | Default  | Description                          |
| ------------------ | -------- | ------------------------------------ |
| `:stream`          | required | Stream handle                        |
| `:producer_id`     | required | Stable producer identifier           |
| `:epoch`           | `0`      | Starting epoch                       |
| `:auto_claim`      | `false`  | Auto-bump epoch on 403               |
| `:max_batch_size`  | `100`    | Max items per batch                  |
| `:max_batch_bytes` | `1MB`    | Max bytes per batch                  |
| `:linger_ms`       | `5`      | Max wait before sending batch        |
| `:max_in_flight`   | `5`      | Max concurrent in-flight batches     |
| `:on_error`        | `nil`    | Error callback `fn error, items -> ` |

## Low-Level API

For simple scripts or custom implementations, use the Stream module directly:

```elixir
alias DurableStreams.Stream, as: DS

# Create
{:ok, stream} = DS.create(stream, content_type: "text/plain")

# Append
{:ok, result} = DS.append(stream, "Hello, World!")

# Read single chunk
{:ok, chunk} = DS.read(stream, offset: "-1")

# Read all available data
{:ok, chunks} = DS.read_all(stream)

# Get metadata
{:ok, meta} = DS.head(stream)

# Delete
:ok = DS.delete(stream)
```

### Manual Idempotent Appends

```elixir
# For manual sequence management
{:ok, _} = DS.append(stream, data,
  producer_id: "my-producer",
  producer_epoch: 0,
  producer_seq: 0
)

# Increment seq for each message
{:ok, _} = DS.append(stream, data2,
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
    # Another producer took over with a higher epoch
    Logger.error("Fenced by epoch #{server_epoch}")

  {:error, :timeout} ->
    # Long-poll timeout with no new data
    :ok

  {:error, reason} ->
    Logger.error("Unexpected error: #{inspect(reason)}")
end
```

## Architecture

```
┌──────────────────────────────────────────────────┐
│   Consumer (GenServer)  │   Writer (GenServer)   │  ← OTP supervision
├──────────────────────────────────────────────────┤
│               Stream (functional core)           │  ← CRUD operations
├──────────────────────────────────────────────────┤
│                      HTTP                        │  ← Connection pooling
└──────────────────────────────────────────────────┘
```

- **Consumer**: Long-running GenServer for reading with auto-reconnect and backoff
- **Writer**: Fire-and-forget producer with batching, pipelining, and exactly-once delivery
- **Stream**: Pure functions for individual operations
- **HTTP**: Connection-pooled HTTP client using Erlang's built-in `:httpc`

## Performance

The client is optimized for production workloads:

- **Connection pooling** - Reuses HTTP connections across requests
- **Automatic batching** - Writer batches multiple appends into single HTTP requests
- **JSON batching** - For `application/json` streams, items are batched into arrays
- **Configurable concurrency** - Control in-flight requests and batch sizes

Throughput depends on your server and network, but the client can handle hundreds of thousands of operations per second.

## Limitations

### SSE (Server-Sent Events)

SSE requires the optional [Finch](https://github.com/sneako/finch) dependency for true incremental streaming:

```elixir
# Add to mix.exs for SSE support
def deps do
  [
    {:durable_streams, "~> 0.1.0"},
    {:finch, "~> 0.18"},
    {:castore, "~> 1.0"}
  ]
end
```

Without Finch, SSE mode falls back to `:long_poll` behavior. The built-in `:httpc` client doesn't support true streaming - it buffers chunks until timeout.

### No External Dependencies

This library uses only Erlang's built-in `:httpc` module and Elixir's native JSON (1.18+). This keeps the dependency footprint minimal but limits throughput compared to specialized HTTP clients.

**Future: Finch Integration**

For higher throughput workloads, we plan to add optional [Finch](https://github.com/sneako/finch) support. Finch builds on Mint with connection pooling and would provide significantly better performance for high-volume producers. In the meantime, the current implementation handles most workloads well and prioritizes reliability over raw throughput.

## Development

```bash
# Compile
mix compile

# Run tests (requires a Durable Streams server)
mix test

# Build conformance test adapter
mix escript.build

# Run conformance tests
cd ../.. && pnpm test:run -- --client elixir
```

## License

MIT - see the [LICENSE](../../LICENSE) file for details.

## Links

- [Durable Streams Protocol](https://github.com/durable-streams/durable-streams/blob/main/PROTOCOL.md)
- [GitHub Repository](https://github.com/durable-streams/durable-streams)
- [TypeScript Client](https://www.npmjs.com/package/@durable-streams/client)
- [Go Client](https://github.com/durable-streams/durable-streams/tree/main/packages/client-go)
- [Python Client](https://pypi.org/project/durable-streams/)
