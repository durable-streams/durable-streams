# DurableStreams Elixir Client

Elixir client library for Durable Streams - persistent, resumable event streams over HTTP.

## Installation

Add `durable_streams` to your list of dependencies in `mix.exs`:

```elixir
def deps do
  [
    {:durable_streams, "~> 0.1.0"}
  ]
end
```

## Usage

### Basic Operations

```elixir
# Create a client
client = DurableStreams.Client.new("http://localhost:8080")

# Get a stream handle
stream = DurableStreams.Client.stream(client, "/my-stream")

# Create the stream
{:ok, stream} = DurableStreams.Stream.create(stream, content_type: "text/plain")

# Append data
{:ok, result} = DurableStreams.Stream.append(stream, "Hello, World!")
# result.next_offset contains the offset after the append

# Read data
{:ok, chunk} = DurableStreams.Stream.read(stream, offset: "-1")
# chunk.data contains the data, chunk.next_offset for subsequent reads

# Read all data
{:ok, chunks} = DurableStreams.Stream.read_all(stream)

# Delete the stream
:ok = DurableStreams.Stream.delete(stream)
```

### Idempotent Producers

Use producer headers for exactly-once delivery:

```elixir
opts = [
  producer_id: "my-producer",
  producer_epoch: 0,
  producer_seq: 0
]

{:ok, _} = DurableStreams.Stream.append(stream, "message-0", opts)

# Increment seq for each message
opts = Keyword.put(opts, :producer_seq, 1)
{:ok, _} = DurableStreams.Stream.append(stream, "message-1", opts)
```

### Stream Options

```elixir
# Create with TTL
DurableStreams.Stream.create(stream,
  content_type: "application/json",
  ttl_seconds: 3600
)

# Read with long-polling
DurableStreams.Stream.read(stream,
  offset: last_offset,
  live: :long_poll,
  timeout: 30_000
)
```

## Design

The Elixir client follows idiomatic patterns:

- **Functional Core**: Pure functions for operations
- **Immutable Structs**: Client and Stream are immutable data structures
- **Error Tuples**: Operations return `{:ok, result}` or `{:error, reason}`
- **No External Dependencies**: Uses only Erlang's built-in `:httpc` module

## Limitations

### SSE (Server-Sent Events)

The current implementation has limited SSE support due to Erlang's `:httpc`
module not supporting streaming responses. SSE connections require the ability
to receive incremental data while the connection remains open, which `:httpc`
doesn't provide out of the box.

For applications requiring real-time streaming:

- Use `:long_poll` mode for near-real-time updates
- Or implement a custom HTTP client using `:gen_tcp` for full SSE support

### Conformance

The client passes 159 out of 177 conformance tests (90%). The failing tests
are all SSE-related due to the limitation mentioned above.

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
