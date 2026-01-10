# Elixir Durable Streams Client Design

## Overview

This document presents a unified design for an idiomatic Elixir client for the Durable Streams protocol. The design synthesizes:

1. **Durable Streams Protocol** - HTTP-based append-only streams with catch-up, long-poll, and SSE modes
2. **Existing Client Patterns** - TypeScript, Python, and Go implementations
3. **Elixir Streaming SDK Patterns** - Broadway, GenStage, brod, gnat, and HTTP streaming libraries

## Design Goals

1. **Idiomatic Elixir** - Leverage OTP patterns (GenServer, Supervisors, GenStage)
2. **Multiple Consumption Styles** - Support sync, async, and streaming patterns
3. **Broadway Integration** - First-class GenStage producer for Broadway pipelines
4. **Resilient Connections** - Automatic reconnection with backoff
5. **Production Ready** - Telemetry, observability, graceful shutdown

---

## Package Structure

```
durable_streams/
├── lib/
│   ├── durable_streams.ex              # Main module & public API
│   ├── durable_streams/
│   │   ├── stream.ex                   # Stream handle (cold reference)
│   │   ├── client.ex                   # HTTP client with pooling
│   │   ├── consumer.ex                 # GenServer for consuming streams
│   │   ├── producer.ex                 # GenStage producer for Broadway
│   │   ├── writer.ex      # Exactly-once producer
│   │   ├── sse.ex                      # SSE parser and connection
│   │   ├── response.ex                 # Response parsing utilities
│   │   ├── errors.ex                   # Error types
│   │   ├── telemetry.ex                # Telemetry events
│   │   └── types.ex                    # Type definitions
│   └── durable_streams/broadway/
│       └── producer.ex                 # Broadway.Producer implementation
├── mix.exs
└── test/
```

---

## Core Types

```elixir
defmodule DurableStreams.Types do
  @moduledoc """
  Core type definitions for the Durable Streams client.
  """

  @type offset :: String.t() | :start | :now
  @type cursor :: String.t() | nil
  @type live_mode :: false | :auto | :long_poll | :sse
  @type content_type :: String.t()

  @type headers :: %{optional(String.t()) => String.t() | (-> String.t())}
  @type params :: %{optional(String.t()) => String.t() | (-> String.t())}

  @type stream_url :: String.t() | URI.t()

  @type batch_meta :: %{
    next_offset: offset(),
    cursor: cursor(),
    up_to_date: boolean()
  }

  @type json_batch(t) :: %{
    items: [t],
    next_offset: offset(),
    cursor: cursor(),
    up_to_date: boolean()
  }

  @type byte_chunk :: %{
    data: binary(),
    next_offset: offset(),
    cursor: cursor(),
    up_to_date: boolean()
  }

  # Idempotent producer types
  @type producer_id :: String.t()
  @type epoch :: non_neg_integer()
  @type seq :: non_neg_integer()
end
```

---

## API Design

### 1. Stream Handle (Cold Reference)

A lightweight struct representing a stream URL with associated options. No network I/O until operations are called.

```elixir
defmodule DurableStreams.Stream do
  @moduledoc """
  A cold handle to a durable stream.

  No network requests are made until an operation is invoked.
  Stream handles are lightweight and can be stored/passed around freely.
  """

  defstruct [
    :url,
    :headers,
    :params,
    :content_type,
    :finch_name,
    :backoff_opts
  ]

  @type t :: %__MODULE__{
    url: String.t(),
    headers: DurableStreams.Types.headers(),
    params: DurableStreams.Types.params(),
    content_type: String.t() | nil,
    finch_name: atom(),
    backoff_opts: keyword()
  }

  @doc """
  Create a new stream handle.

  ## Options

  - `:headers` - HTTP headers (static or dynamic functions)
  - `:params` - Query parameters (static or dynamic functions)
  - `:content_type` - Default content type for the stream
  - `:finch_name` - Finch pool name (default: `DurableStreams.Finch`)
  - `:backoff_opts` - Backoff configuration for retries

  ## Examples

      iex> stream = DurableStreams.Stream.new("https://example.com/streams/my-stream",
      ...>   headers: %{"authorization" => "Bearer token"},
      ...>   content_type: "application/json"
      ...> )
      %DurableStreams.Stream{url: "https://example.com/streams/my-stream", ...}
  """
  @spec new(String.t() | URI.t(), keyword()) :: t()
  def new(url, opts \\ [])

  @doc """
  Create the stream on the server (PUT).

  Returns `{:ok, stream}` on success or `{:error, reason}` on failure.
  Idempotent - returns `:ok` if stream already exists with same config.
  """
  @spec create(t(), keyword()) :: {:ok, t()} | {:error, term()}
  def create(stream, opts \\ [])

  @doc """
  Check stream existence and fetch metadata (HEAD).
  """
  @spec head(t(), keyword()) :: {:ok, head_result()} | {:error, term()}
  def head(stream, opts \\ [])

  @doc """
  Delete the stream (DELETE).
  """
  @spec delete(t(), keyword()) :: :ok | {:error, term()}
  def delete(stream, opts \\ [])

  @doc """
  Append data to the stream (POST).

  For JSON streams, data is automatically wrapped in an array.
  For byte streams, accepts binary or iodata.
  """
  @spec append(t(), term(), keyword()) :: :ok | {:error, term()}
  def append(stream, data, opts \\ [])

  @doc """
  Read from the stream with various consumption modes.

  ## Options

  - `:offset` - Starting offset (default: `:start` or `"-1"`)
  - `:live` - Live mode: `false`, `:auto`, `:long_poll`, `:sse`

  ## Examples

      # Catch-up read (returns batch with metadata for resumability)
      {:ok, batch} = DurableStreams.Stream.read_json(stream, live: false)
      # batch.items - the JSON items
      # batch.next_offset - offset for next request (resumption point)
      # batch.cursor - cursor for CDN collapsing
      # batch.up_to_date - true when caught up with stream tail

      # Live streaming with callback
      DurableStreams.Stream.subscribe_json(stream, fn batch ->
        IO.inspect(batch.items)
        :ok
      end)

  ## Return Values

  All read functions return `{:ok, batch}` where batch includes:
  - `items` / `data` / `text` - the actual content
  - `next_offset` - the offset to use for subsequent requests
  - `cursor` - cursor for CDN collapsing in live mode
  - `up_to_date` - boolean indicating if stream tail was reached

  This ensures resumability metadata is always available, even for simple scripts.
  """
  @spec read_json(t(), keyword()) :: {:ok, json_batch(term())} | {:error, term()}
  def read_json(stream, opts \\ [])

  @spec read_bytes(t(), keyword()) :: {:ok, byte_chunk()} | {:error, term()}
  def read_bytes(stream, opts \\ [])

  @spec read_text(t(), keyword()) :: {:ok, text_chunk()} | {:error, term()}
  def read_text(stream, opts \\ [])
end
```

### 2. Consumer (GenServer)

Long-running process for consuming a stream with backpressure and reconnection.

```elixir
defmodule DurableStreams.Consumer do
  @moduledoc """
  A GenServer-based consumer for durable streams.

  Manages connection lifecycle, automatic reconnection with backoff,
  and delivers messages to a callback module.

  ## Delivery Semantics

  The Consumer provides **at-least-once** delivery with the following guarantees:

  - **Offset advancement**: The internal offset is only advanced AFTER
    `handle_batch/2` returns `{:ok, new_state}`. If the callback crashes
    or returns `{:stop, ...}`, the offset is NOT advanced.

  - **Crash recovery**: If the Consumer process crashes mid-batch, on restart
    it will re-fetch from the last committed offset, potentially re-delivering
    the same batch. Design your handlers to be idempotent.

  - **Ordered delivery**: Batches are delivered in offset order, one at a time.
    A new batch is not fetched until the previous one is fully processed.

  - **No overlap**: Each message is delivered exactly once per successful
    `handle_batch/2` call. However, restarts may cause re-delivery.

  ## Checkpointing

  The Consumer tracks two offsets:

  - `committed_offset/1` - Last successfully processed offset (safe for external persistence)
  - `inflight_offset/1` - Offset being currently processed (may not be committed yet)

  For durable checkpointing, persist `committed_offset/1` to your database and
  pass it as the `:offset` option when restarting the Consumer.

  ## Callback Module

  Implement the `DurableStreams.Consumer` behaviour:

      defmodule MyConsumer do
        @behaviour DurableStreams.Consumer

        @impl true
        def init(args) do
          {:ok, %{count: 0}}
        end

        @impl true
        def handle_batch(batch, state) do
          # Process batch.items
          {:ok, %{state | count: state.count + length(batch.items)}}
        end

        @impl true
        def handle_error(error, state) do
          # Return :reconnect to retry, :stop to terminate
          {:reconnect, state}
        end
      end

  ## Starting a Consumer

      {:ok, pid} = DurableStreams.Consumer.start_link(
        stream: DurableStreams.Stream.new("https://..."),
        callback_module: MyConsumer,
        callback_args: [],
        live: :long_poll,
        offset: :start
      )
  """
  use GenServer
  require Logger

  @callback init(args :: term()) :: {:ok, state :: term()} | {:stop, reason :: term()}
  @callback handle_batch(batch :: json_batch(term()), state :: term()) ::
    {:ok, state :: term()} | {:stop, reason :: term(), state :: term()}
  @callback handle_error(error :: term(), state :: term()) ::
    {:reconnect, state :: term()} | {:stop, reason :: term(), state :: term()}

  defstruct [
    :stream,
    :callback_module,
    :callback_state,
    :live_mode,
    :committed_offset,    # Last successfully processed offset
    :inflight_offset,     # Offset currently being processed
    :cursor,
    :backoff,
    :request_ref
  ]

  # Client API

  def start_link(opts) do
    GenServer.start_link(__MODULE__, opts, Keyword.take(opts, [:name]))
  end

  def stop(consumer, reason \\ :normal) do
    GenServer.stop(consumer, reason)
  end

  @doc """
  Get the last committed offset (safe for checkpointing).

  This offset represents the last batch that was successfully processed.
  Use this value when persisting offsets for resumption.
  """
  def committed_offset(consumer) do
    GenServer.call(consumer, :get_committed_offset)
  end

  @doc """
  Get the in-flight offset (currently being processed).

  This may be ahead of committed_offset if a batch is currently being processed.
  """
  def inflight_offset(consumer) do
    GenServer.call(consumer, :get_inflight_offset)
  end

  @doc "Deprecated: use committed_offset/1 instead"
  @deprecated "Use committed_offset/1 instead"
  def offset(consumer), do: committed_offset(consumer)

  # GenServer callbacks

  @impl true
  def init(opts) do
    stream = Keyword.fetch!(opts, :stream)
    callback_module = Keyword.fetch!(opts, :callback_module)
    callback_args = Keyword.get(opts, :callback_args, [])
    live_mode = Keyword.get(opts, :live, :long_poll)
    offset = Keyword.get(opts, :offset, :start)

    case callback_module.init(callback_args) do
      {:ok, callback_state} ->
        state = %__MODULE__{
          stream: stream,
          callback_module: callback_module,
          callback_state: callback_state,
          live_mode: live_mode,
          committed_offset: offset,
          inflight_offset: nil,
          cursor: nil,
          backoff: :backoff.init(1_000, 30_000)
        }

        # Start polling
        send(self(), :poll)
        {:ok, state}

      {:stop, reason} ->
        {:stop, reason}
    end
  end

  @impl true
  def handle_info(:poll, state) do
    # Implementation handles HTTP request, parsing, callback invocation
    # Automatic reconnection with backoff on failure
    # ...
  end

  @impl true
  def handle_info({:finch_response, ref, result}, state) do
    # Handle async Finch response
    # ...
  end

  @impl true
  def terminate(_reason, state) do
    # Emit telemetry, cleanup
    :ok
  end
end
```

### 3. GenStage Producer (Broadway Integration)

```elixir
defmodule DurableStreams.Producer do
  @moduledoc """
  A GenStage producer for durable streams.

  Integrates with Broadway and GenStage pipelines for backpressure-aware
  consumption.

  ## With Broadway

      defmodule MyBroadway do
        use Broadway

        def start_link(_opts) do
          Broadway.start_link(__MODULE__,
            name: __MODULE__,
            producer: [
              module: {DurableStreams.Broadway.Producer, [
                stream: DurableStreams.Stream.new("https://...",
                  headers: %{"authorization" => "Bearer token"}
                ),
                live: :long_poll,
                offset: :start
              ]},
              concurrency: 1
            ],
            processors: [
              default: [concurrency: 10]
            ],
            batchers: [
              default: [batch_size: 100, batch_timeout: 200]
            ]
          )
        end

        @impl true
        def handle_message(_processor, message, _context) do
          # message.data contains the JSON item
          # message.metadata contains offset, cursor, etc.
          message
        end

        @impl true
        def handle_batch(:default, messages, _batch_info, _context) do
          # Bulk processing
          messages
        end
      end

  ## Standalone GenStage

      {:ok, producer} = DurableStreams.Producer.start_link(
        stream: my_stream,
        live: :long_poll
      )

      {:ok, consumer} = GenStage.start_link(MyConsumer, :ok)
      GenStage.sync_subscribe(consumer, to: producer, max_demand: 100)
  """
  use GenStage
  require Logger

  defstruct [
    :stream,
    :live_mode,
    :offset,
    :cursor,
    :demand,
    :buffer,
    :request_ref,
    :backoff
  ]

  # Client API

  def start_link(opts) do
    GenStage.start_link(__MODULE__, opts, Keyword.take(opts, [:name]))
  end

  # GenStage callbacks

  @impl true
  def init(opts) do
    stream = Keyword.fetch!(opts, :stream)
    live_mode = Keyword.get(opts, :live, :long_poll)
    offset = Keyword.get(opts, :offset, :start)

    state = %__MODULE__{
      stream: stream,
      live_mode: live_mode,
      offset: offset,
      cursor: nil,
      demand: 0,
      buffer: :queue.new(),
      request_ref: nil,
      backoff: :backoff.init(1_000, 30_000)
    }

    {:producer, state}
  end

  @impl true
  def handle_demand(incoming_demand, state) do
    new_demand = state.demand + incoming_demand
    state = %{state | demand: new_demand}

    # Dispatch buffered events or fetch more
    dispatch_events(state)
  end

  @impl true
  def handle_info({:finch_response, ref, result}, state) do
    # Handle async HTTP response
    # Parse events, add to buffer, dispatch
    # ...
  end

  defp dispatch_events(state) do
    # Dispatch events from buffer up to demand
    # If buffer empty and demand > 0, initiate fetch
    # ...
  end
end
```

### 4. Broadway Producer

```elixir
defmodule DurableStreams.Broadway.Producer do
  @moduledoc """
  Broadway producer for Durable Streams.

  Implements `Broadway.Producer` behaviour for seamless integration
  with Broadway pipelines.

  ## Delivery Semantics

  By default, this producer provides **at-least-once** delivery:
  - Offset is only advanced when Broadway successfully acks a batch
  - On crash/restart, unacked messages will be re-delivered
  - Duplicate processing is possible; design handlers to be idempotent

  Use `commit: :on_receive` for **at-most-once** delivery if duplicates
  are worse than data loss for your use case.

  ## Options

  - `:commit` - When to advance offset (default: `:on_ack`)
    - `:on_ack` - Advance after Broadway acks (at-least-once)
    - `:on_receive` - Advance immediately on receive (at-most-once)
  """
  use GenStage
  @behaviour Broadway.Producer

  alias Broadway.Message

  defstruct [
    :stream,
    :live_mode,
    :commit_mode,           # :on_ack or :on_receive
    :committed_offset,      # Last offset confirmed durable (for resumption)
    :pending_offset,        # Offset of in-flight batch (not yet acked)
    :cursor,
    :ack_ref,
    :pending_demand,
    :buffer,
    :request_ref,
    :backoff,
    :receive_interval,
    :in_flight_batches      # %{batch_id => %{next_offset: ..., count: ...}}
  ]

  @impl true
  def init(opts) do
    stream = Keyword.fetch!(opts, :stream)
    live_mode = Keyword.get(opts, :live, :long_poll)
    offset = Keyword.get(opts, :offset, :start)
    commit_mode = Keyword.get(opts, :commit, :on_ack)
    receive_interval = Keyword.get(opts, :receive_interval, 5_000)

    state = %__MODULE__{
      stream: stream,
      live_mode: live_mode,
      commit_mode: commit_mode,
      committed_offset: offset,
      pending_offset: nil,
      cursor: nil,
      ack_ref: make_ref(),
      pending_demand: 0,
      buffer: [],
      request_ref: nil,
      backoff: :backoff.init(1_000, 30_000),
      receive_interval: receive_interval,
      in_flight_batches: %{}
    }

    {:producer, state}
  end

  @impl true
  def handle_demand(incoming_demand, state) do
    new_demand = state.pending_demand + incoming_demand
    state = %{state | pending_demand: new_demand}
    maybe_fetch(state)
  end

  @impl true
  def handle_info(:fetch, state) do
    maybe_fetch(%{state | request_ref: nil})
  end

  @impl true
  def handle_info({:finch_response, _ref, {:ok, batch}}, state) do
    batch_id = make_ref()

    messages = Enum.map(batch.items, fn item ->
      %Message{
        data: item,
        metadata: %{
          batch_id: batch_id,
          next_offset: batch.next_offset,
          cursor: batch.cursor,
          up_to_date: batch.up_to_date
        },
        acknowledger: {__MODULE__, state.ack_ref, %{batch_id: batch_id}}
      }
    end)

    # Track in-flight batch for ack-based offset advancement
    in_flight = Map.put(state.in_flight_batches, batch_id, %{
      next_offset: batch.next_offset,
      count: length(messages)
    })

    new_state = case state.commit_mode do
      :on_receive ->
        # At-most-once: advance offset immediately
        %{state |
          committed_offset: batch.next_offset,
          cursor: batch.cursor,
          pending_demand: max(0, state.pending_demand - length(messages)),
          backoff: :backoff.succeed(state.backoff),
          in_flight_batches: in_flight
        }

      :on_ack ->
        # At-least-once: keep committed_offset unchanged until ack
        %{state |
          pending_offset: batch.next_offset,
          cursor: batch.cursor,
          pending_demand: max(0, state.pending_demand - length(messages)),
          backoff: :backoff.succeed(state.backoff),
          in_flight_batches: in_flight
        }
    end

    {:noreply, messages, new_state}
  end

  @impl true
  def handle_info({:finch_response, _ref, {:error, reason}}, state) do
    Logger.warning("Durable Streams fetch error: #{inspect(reason)}")

    {delay, new_backoff} = :backoff.fail(state.backoff)
    Process.send_after(self(), :fetch, delay)

    {:noreply, [], %{state | backoff: new_backoff, request_ref: nil}}
  end

  # Broadway.Producer callbacks

  @impl Broadway.Producer
  def prepare_for_draining(state) do
    # Cancel any in-flight request
    {:noreply, [], state}
  end

  @doc """
  Acknowledger callback - advances offset on successful ack.

  For at-least-once delivery, offset is only advanced when all messages
  in a batch are successfully processed.
  """
  @doc false
  def ack(ack_ref, successful, failed) do
    # Notify producer of successful/failed batches
    # Group by batch_id and send to producer process
    successful_batch_ids =
      successful
      |> Enum.map(fn %{acknowledger: {_, _, %{batch_id: id}}} -> id end)
      |> Enum.uniq()

    failed_batch_ids =
      failed
      |> Enum.map(fn {%{acknowledger: {_, _, %{batch_id: id}}}, _reason} -> id end)
      |> Enum.uniq()

    # Send ack info back to producer (ack_ref contains producer pid)
    send(ack_ref, {:batch_ack, successful_batch_ids, failed_batch_ids})
    :ok
  end

  @impl true
  def handle_info({:batch_ack, successful_ids, _failed_ids}, state) do
    # Only advance offset for successfully acked batches
    new_state =
      Enum.reduce(successful_ids, state, fn batch_id, acc ->
        case Map.pop(acc.in_flight_batches, batch_id) do
          {nil, _} ->
            acc

          {%{next_offset: next_offset}, remaining} ->
            # Advance committed offset for successfully acked batch
            %{acc |
              committed_offset: next_offset,
              in_flight_batches: remaining
            }
        end
      end)

    {:noreply, [], new_state}
  end

  @doc "Get the current committed offset (safe for checkpointing)"
  def committed_offset(producer) do
    GenStage.call(producer, :get_committed_offset)
  end

  @impl true
  def handle_call(:get_committed_offset, _from, state) do
    {:reply, state.committed_offset, [], state}
  end

  defp maybe_fetch(%{pending_demand: 0} = state), do: {:noreply, [], state}
  defp maybe_fetch(%{request_ref: ref} = state) when ref != nil, do: {:noreply, [], state}
  defp maybe_fetch(state) do
    # Use committed_offset for fetching (resumption point)
    # Initiate async HTTP request
    # Store request_ref in state
    # ...
    {:noreply, [], state}
  end
end
```

### 5. Idempotent Producer

```elixir
defmodule DurableStreams.Writer do
  @moduledoc """
  Fire-and-forget producer with exactly-once write semantics.

  Implements Kafka-style idempotent producer pattern:
  - Client-provided producer IDs (zero RTT overhead)
  - Client-declared epochs, server-validated fencing
  - Per-batch sequence numbers for deduplication
  - Automatic batching and pipelining

  ## Example

      {:ok, producer} = DurableStreams.Writer.start_link(
        stream: my_stream,
        producer_id: "order-service-1",
        epoch: 0,
        auto_claim: true
      )

      # Fire-and-forget (returns immediately)
      :ok = DurableStreams.Writer.append(producer, %{event: "created"})
      :ok = DurableStreams.Writer.append(producer, %{event: "updated"})

      # Wait for all pending writes
      :ok = DurableStreams.Writer.flush(producer)

      # Graceful shutdown
      :ok = DurableStreams.Writer.close(producer)

  ## Options

  - `:producer_id` - Stable identifier for this producer (required)
  - `:epoch` - Starting epoch (default: 0), increment on restart
  - `:auto_claim` - On 403, automatically retry with epoch+1 (default: false)
  - `:max_batch_bytes` - Max bytes before sending batch (default: 1MB)
  - `:linger_ms` - Max wait time before sending batch (default: 5ms)
  - `:max_in_flight` - Max concurrent batches (default: 5)
  - `:on_error` - Error callback for fire-and-forget mode
  """
  use GenServer
  require Logger

  defstruct [
    :stream,
    :producer_id,
    :epoch,
    :next_seq,
    :auto_claim,
    :max_batch_bytes,
    :linger_ms,
    :max_in_flight,
    :on_error,
    :pending_batch,
    :batch_bytes,
    :linger_timer,
    :in_flight,
    :flush_waiters,
    :epoch_claimed,
    :seq_state
  ]

  # Client API

  def start_link(opts) do
    GenServer.start_link(__MODULE__, opts, Keyword.take(opts, [:name]))
  end

  @doc """
  Append data to the stream (fire-and-forget).

  Returns immediately. Data is batched and sent asynchronously.
  Errors are reported via the `:on_error` callback.
  """
  @spec append(GenServer.server(), term()) :: :ok
  def append(producer, data) do
    GenServer.cast(producer, {:append, data})
  end

  @doc """
  Flush all pending and in-flight batches.

  Blocks until all writes are confirmed by the server.
  """
  @spec flush(GenServer.server(), timeout()) :: :ok | {:error, term()}
  def flush(producer, timeout \\ 30_000) do
    GenServer.call(producer, :flush, timeout)
  end

  @doc """
  Gracefully close the producer.

  Flushes pending writes before stopping.
  """
  @spec close(GenServer.server(), timeout()) :: :ok
  def close(producer, timeout \\ 30_000) do
    GenServer.call(producer, :close, timeout)
  end

  @doc """
  Restart with a new epoch.

  Flushes pending writes, increments epoch, resets sequence.
  """
  @spec restart(GenServer.server(), timeout()) :: :ok
  def restart(producer, timeout \\ 30_000) do
    GenServer.call(producer, :restart, timeout)
  end

  @doc "Get current epoch"
  @spec epoch(GenServer.server()) :: non_neg_integer()
  def epoch(producer), do: GenServer.call(producer, :get_epoch)

  @doc "Get next sequence number"
  @spec next_seq(GenServer.server()) :: non_neg_integer()
  def next_seq(producer), do: GenServer.call(producer, :get_next_seq)

  # GenServer callbacks

  @impl true
  def init(opts) do
    stream = Keyword.fetch!(opts, :stream)
    producer_id = Keyword.fetch!(opts, :producer_id)
    epoch = Keyword.get(opts, :epoch, 0)
    auto_claim = Keyword.get(opts, :auto_claim, false)
    max_batch_bytes = Keyword.get(opts, :max_batch_bytes, 1_048_576)
    linger_ms = Keyword.get(opts, :linger_ms, 5)
    max_in_flight = Keyword.get(opts, :max_in_flight, 5)
    on_error = Keyword.get(opts, :on_error)

    state = %__MODULE__{
      stream: stream,
      producer_id: producer_id,
      epoch: epoch,
      next_seq: 0,
      auto_claim: auto_claim,
      max_batch_bytes: max_batch_bytes,
      linger_ms: linger_ms,
      max_in_flight: max_in_flight,
      on_error: on_error,
      pending_batch: [],
      batch_bytes: 0,
      linger_timer: nil,
      in_flight: %{},  # seq => {batch, task}
      flush_waiters: [],
      epoch_claimed: not auto_claim,
      seq_state: %{}  # For 409 retry coordination
    }

    {:ok, state}
  end

  @impl true
  def handle_cast({:append, data}, state) do
    # Add to pending batch
    # Check if batch should be sent (size limit or linger timeout)
    # ...
    {:noreply, state}
  end

  @impl true
  def handle_call(:flush, from, state) do
    # Send pending batch if any
    # Add caller to flush_waiters
    # Reply when all in_flight complete
    # ...
    {:noreply, state}
  end

  @impl true
  def handle_call(:close, from, state) do
    # Flush then stop
    # ...
    {:stop, :normal, :ok, state}
  end

  @impl true
  def handle_info(:linger_timeout, state) do
    # Send pending batch
    # ...
    {:noreply, state}
  end

  @impl true
  def handle_info({:batch_complete, seq, result}, state) do
    # Handle batch completion
    # Signal seq completion for 409 coordination
    # Notify flush_waiters if all complete
    # ...
    {:noreply, state}
  end
end
```

---

## HTTP Client Layer

```elixir
defmodule DurableStreams.Client do
  @moduledoc """
  HTTP client layer using Finch for connection pooling.

  Features:
  - Connection pooling with HTTP/2 support
  - Automatic retry with exponential backoff
  - Request/response logging via Telemetry
  """

  @default_pool_size 10
  @default_pool_count 1

  @doc """
  Start the Finch pool for Durable Streams.

  Add to your application supervision tree:

      children = [
        {DurableStreams.Client, name: DurableStreams.Finch}
      ]
  """
  def child_spec(opts) do
    name = Keyword.get(opts, :name, DurableStreams.Finch)
    pool_size = Keyword.get(opts, :pool_size, @default_pool_size)
    pool_count = Keyword.get(opts, :pool_count, @default_pool_count)

    %{
      id: name,
      start: {Finch, :start_link, [[
        name: name,
        pools: %{
          :default => [size: pool_size, count: pool_count]
        }
      ]]}
    }
  end

  @doc """
  Make an HTTP request with automatic retry.

  ## Status Code Handling

  - **Success**: 200, 201, 204, 206 - return `{:ok, response}`
  - **Retryable**: 429, 500, 502, 503, 504 - retry with backoff
  - **Fatal**: 400, 401, 403, 404, 409, 410 - return typed error immediately

  For 429 responses, respects `Retry-After` header if present.
  """
  @spec request(Finch.Request.t(), atom(), keyword()) ::
    {:ok, Finch.Response.t()} | {:error, term()}
  def request(req, finch_name \\ DurableStreams.Finch, opts \\ []) do
    backoff = Keyword.get(opts, :backoff, :backoff.init(100, 10_000))
    max_retries = Keyword.get(opts, :max_retries, 5)

    do_request_with_retry(req, finch_name, backoff, 0, max_retries)
  end

  @doc """
  Make a streaming HTTP request.

  Calls the callback function for each chunk of data received.
  """
  @spec stream(Finch.Request.t(), atom(), (binary() -> :ok | {:error, term()})) ::
    {:ok, Finch.Response.t()} | {:error, term()}
  def stream(req, finch_name \\ DurableStreams.Finch, callback) do
    Finch.stream(req, finch_name, nil, fn
      {:status, status}, acc -> {:cont, Map.put(acc || %{}, :status, status)}
      {:headers, headers}, acc -> {:cont, Map.put(acc, :headers, headers)}
      {:data, data}, acc ->
        case callback.(data) do
          :ok -> {:cont, acc}
          {:error, _} = err -> {:halt, err}
        end
    end)
  end

  # Status code classification
  defp success_status?(status), do: status in [200, 201, 204, 206]
  defp retryable_status?(status), do: status in [429, 500, 502, 503, 504]
  defp fatal_status?(status), do: status in [400, 401, 403, 404, 409, 410]

  defp do_request_with_retry(req, finch_name, backoff, attempt, max_retries) do
    start_time = System.monotonic_time()

    :telemetry.execute(
      [:durable_streams, :request, :start],
      %{system_time: System.system_time()},
      %{method: req.method, url: req.path, attempt: attempt}
    )

    case Finch.request(req, finch_name) do
      {:ok, %{status: status} = resp} when success_status?(status) ->
        emit_stop(start_time, req, status)
        {:ok, resp}

      {:ok, %{status: 429} = resp} when attempt < max_retries ->
        # Rate limited - respect Retry-After header
        emit_stop(start_time, req, 429)
        delay = get_retry_after(resp) || calculate_backoff_delay(backoff)
        Process.sleep(delay)
        {_, new_backoff} = :backoff.fail(backoff)
        do_request_with_retry(req, finch_name, new_backoff, attempt + 1, max_retries)

      {:ok, %{status: 429} = resp} ->
        # Rate limited - max retries exceeded
        emit_stop(start_time, req, 429)
        retry_after = get_retry_after(resp)
        {:error, %DurableStreams.Error.RateLimited{url: req.path, retry_after: retry_after}}

      {:ok, %{status: 410} = resp} ->
        # Gone - data compacted/expired
        emit_stop(start_time, req, 410)
        earliest = get_header(resp, "stream-earliest-offset")
        {:error, %DurableStreams.Error.Gone{
          url: req.path,
          requested_offset: nil, # caller should fill this in
          earliest_offset: earliest
        }}

      {:ok, %{status: status} = resp} when retryable_status?(status) and attempt < max_retries ->
        # 5xx - retry with backoff
        emit_stop(start_time, req, status)
        {delay, new_backoff} = :backoff.fail(backoff)
        Process.sleep(delay)
        do_request_with_retry(req, finch_name, new_backoff, attempt + 1, max_retries)

      {:ok, %{status: status} = resp} when fatal_status?(status) ->
        # Fatal error - don't retry
        emit_stop(start_time, req, status)
        {:error, classify_error(status, req.path, resp)}

      {:ok, %{status: status} = resp} ->
        # Unexpected status or max retries exceeded
        emit_stop(start_time, req, status)
        {:error, %DurableStreams.Error.ServerError{url: req.path, status: status, body: resp.body}}

      {:error, reason} when attempt < max_retries ->
        # Network error - retry with backoff
        {delay, new_backoff} = :backoff.fail(backoff)
        Process.sleep(delay)
        do_request_with_retry(req, finch_name, new_backoff, attempt + 1, max_retries)

      {:error, reason} ->
        {:error, reason}
    end
  end

  defp emit_stop(start_time, req, status) do
    duration = System.monotonic_time() - start_time
    :telemetry.execute(
      [:durable_streams, :request, :stop],
      %{duration: duration},
      %{method: req.method, url: req.path, status: status}
    )
  end

  defp get_retry_after(resp) do
    case get_header(resp, "retry-after") do
      nil -> nil
      value -> parse_retry_after(value)
    end
  end

  defp parse_retry_after(value) do
    case Integer.parse(value) do
      {seconds, ""} -> seconds * 1000  # Convert to ms
      _ -> nil  # Could be HTTP-date, fall back to backoff
    end
  end

  defp get_header(%{headers: headers}, name) do
    Enum.find_value(headers, fn {k, v} ->
      if String.downcase(k) == name, do: v
    end)
  end

  defp calculate_backoff_delay(backoff) do
    {delay, _} = :backoff.fail(backoff)
    delay
  end

  defp classify_error(400, url, resp), do: %DurableStreams.Error.BadRequest{url: url, details: resp.body}
  defp classify_error(401, url, _resp), do: %DurableStreams.Error.Unauthorized{url: url}
  defp classify_error(403, url, _resp), do: %DurableStreams.Error.Forbidden{url: url}
  defp classify_error(404, url, _resp), do: %DurableStreams.Error.NotFound{url: url}
  defp classify_error(409, url, resp), do: %DurableStreams.Error.Conflict{url: url, reason: resp.body}
  defp classify_error(status, url, resp), do: %DurableStreams.Error.ServerError{url: url, status: status, body: resp.body}
end
```

---

## SSE Parser

```elixir
defmodule DurableStreams.SSE do
  @moduledoc """
  Server-Sent Events parser for Durable Streams.

  Parses the SSE format with support for:
  - `data` events containing JSON payloads
  - `control` events with offset and cursor metadata

  ## Error Handling

  JSON parse errors are returned as `{:error, {:bad_json, raw_data}}`
  rather than crashing, allowing callers to decide how to handle malformed data.

  ## Line Ending Support

  Handles both LF (`\\n`) and CRLF (`\\r\\n`) line endings for compatibility
  with various server implementations.
  """

  defstruct [:buffer, :current_event, :current_data]

  @type t :: %__MODULE__{
    buffer: binary(),
    current_event: String.t() | nil,
    current_data: [binary()]
  }

  @type event ::
    {:data, term()} |
    {:control, %{stream_next_offset: String.t(), stream_cursor: String.t()}} |
    {:error, {:bad_json, String.t()}}

  @doc "Create a new SSE parser state"
  @spec new() :: t()
  def new do
    %__MODULE__{
      buffer: "",
      current_event: nil,
      current_data: []
    }
  end

  @doc """
  Parse SSE data chunk, returns events and updated state.

  Returns `{events, new_state}` where events may include error tuples
  for malformed JSON data.
  """
  @spec parse(t(), binary()) :: {[event()], t()}
  def parse(state, chunk) do
    buffer = state.buffer <> chunk
    parse_lines(buffer, state.current_event, state.current_data, [])
  end

  defp parse_lines(buffer, event, data, events) do
    # Split on LF, handling CRLF by trimming CR from line ends
    case String.split(buffer, "\n", parts: 2) do
      [line, rest] ->
        # Trim trailing CR for CRLF compatibility
        line = String.trim_trailing(line, "\r")

        case parse_line(line) do
          {:event, event_type} ->
            parse_lines(rest, event_type, [], events)

          {:data, data_line} ->
            parse_lines(rest, event, [data_line | data], events)

          :empty ->
            # End of event
            if event != nil and data != [] do
              parsed = finalize_event(event, Enum.reverse(data))
              parse_lines(rest, nil, [], [parsed | events])
            else
              parse_lines(rest, nil, [], events)
            end

          :ignore ->
            parse_lines(rest, event, data, events)
        end

      [incomplete] ->
        state = %__MODULE__{
          buffer: incomplete,
          current_event: event,
          current_data: data
        }
        {Enum.reverse(events), state}
    end
  end

  defp parse_line("event: " <> event_type), do: {:event, String.trim(event_type)}
  defp parse_line("event:" <> event_type), do: {:event, String.trim(event_type)}
  defp parse_line("data: " <> data), do: {:data, data}
  defp parse_line("data:" <> data), do: {:data, data}
  defp parse_line(""), do: :empty
  defp parse_line(":" <> _comment), do: :ignore
  defp parse_line(_other), do: :ignore

  defp finalize_event("data", data_lines) do
    json = Enum.join(data_lines, "\n")

    case Jason.decode(json) do
      {:ok, decoded} ->
        {:data, decoded}

      {:error, _reason} ->
        # Return error tuple instead of crashing - let caller decide
        {:error, {:bad_json, json}}
    end
  end

  defp finalize_event("control", data_lines) do
    json = Enum.join(data_lines, "\n")

    case Jason.decode(json) do
      {:ok, control} ->
        {:control, %{
          stream_next_offset: control["streamNextOffset"],
          stream_cursor: control["streamCursor"],
          up_to_date: control["upToDate"] || false
        }}

      {:error, _reason} ->
        # Control events are critical - return error
        {:error, {:bad_control_json, json}}
    end
  end
end
```

---

## Error Types

```elixir
defmodule DurableStreams.Error do
  @moduledoc """
  Error types for Durable Streams operations.

  ## Error Classification

  Errors are classified by recoverability:

  - **Retryable**: Network errors, 429, 500, 503 - retry with backoff
  - **Fatal**: 400, 401, 403, 404, 409, 410 - do not retry automatically
  - **Recoverable**: 410 Gone - can recover by jumping to earliest offset
  """

  defmodule NotFound do
    @moduledoc "Stream does not exist (404)"
    defexception [:url, :message]

    @impl true
    def message(%{url: url}) do
      "Stream not found: #{url}"
    end
  end

  defmodule Gone do
    @moduledoc """
    Requested offset is before earliest retained position (410).

    This occurs when:
    - Data has been compacted/expired due to retention policy
    - Offset refers to data that no longer exists

    The `earliest_offset` field indicates where valid data begins.
    Clients can either:
    - Fail hard (data loss is unacceptable)
    - Jump to earliest_offset and continue (acceptable for ephemeral streams)
    """
    defexception [:url, :requested_offset, :earliest_offset, :message]

    @impl true
    def message(%{url: url, requested_offset: req, earliest_offset: earliest}) do
      "Offset #{req} is gone on #{url}. Earliest available: #{earliest}"
    end
  end

  defmodule Conflict do
    @moduledoc "Conflict with existing state (409)"
    defexception [:url, :reason, :message]

    @impl true
    def message(%{url: url, reason: reason}) do
      "Conflict on #{url}: #{reason}"
    end
  end

  defmodule StaleEpoch do
    @moduledoc "Producer epoch is stale - fenced by newer producer (403)"
    defexception [:current_epoch, :message]

    @impl true
    def message(%{current_epoch: epoch}) do
      "Producer epoch is stale. Server epoch: #{epoch}. Call restart/1 or create new producer."
    end
  end

  defmodule SequenceGap do
    @moduledoc "Sequence number gap detected (409)"
    defexception [:expected_seq, :received_seq, :message]

    @impl true
    def message(%{expected_seq: expected, received_seq: received}) do
      "Sequence gap: expected #{expected}, received #{received}"
    end
  end

  defmodule BadRequest do
    @moduledoc "Malformed request (400)"
    defexception [:url, :details, :message]
  end

  defmodule RateLimited do
    @moduledoc """
    Rate limit exceeded (429).

    The `retry_after` field contains the server-suggested wait time in seconds.
    Clients should wait at least this long before retrying.
    """
    defexception [:url, :retry_after, :message]

    @impl true
    def message(%{url: url, retry_after: retry_after}) do
      "Rate limited on #{url}. Retry after: #{retry_after}s"
    end
  end

  defmodule ServerError do
    @moduledoc "Server error (5xx) - typically retryable"
    defexception [:url, :status, :body, :message]
  end

  defmodule Unauthorized do
    @moduledoc "Authentication required or invalid (401)"
    defexception [:url, :message]
  end

  defmodule Forbidden do
    @moduledoc "Access denied (403)"
    defexception [:url, :message]
  end
end
```

---

## Telemetry Events

```elixir
defmodule DurableStreams.Telemetry do
  @moduledoc """
  Telemetry events for observability.

  ## Events

  ### HTTP Requests

  - `[:durable_streams, :request, :start]` - Request initiated
    - Measurements: `%{system_time: integer()}`
    - Metadata: `%{method: atom(), url: String.t(), attempt: integer()}`

  - `[:durable_streams, :request, :stop]` - Request completed
    - Measurements: `%{duration: integer()}`
    - Metadata: `%{method: atom(), url: String.t(), status: integer()}`

  - `[:durable_streams, :request, :exception]` - Request failed
    - Measurements: `%{duration: integer()}`
    - Metadata: `%{method: atom(), url: String.t(), kind: atom(), reason: term()}`

  ### Consumer

  - `[:durable_streams, :consumer, :batch]` - Batch received
    - Measurements: `%{count: integer(), bytes: integer()}`
    - Metadata: `%{stream_url: String.t(), offset: String.t()}`

  - `[:durable_streams, :consumer, :reconnect]` - Reconnection attempt
    - Measurements: `%{attempt: integer(), delay_ms: integer()}`
    - Metadata: `%{stream_url: String.t(), reason: term()}`

  ### Producer

  - `[:durable_streams, :producer, :batch_sent]` - Batch sent
    - Measurements: `%{count: integer(), bytes: integer(), duration: integer()}`
    - Metadata: `%{stream_url: String.t(), epoch: integer(), seq: integer()}`

  - `[:durable_streams, :producer, :duplicate]` - Duplicate detected
    - Measurements: `%{}`
    - Metadata: `%{stream_url: String.t(), epoch: integer(), seq: integer()}`
  """

  @doc "Attach default log handler for debugging"
  def attach_default_logger do
    events = [
      [:durable_streams, :request, :start],
      [:durable_streams, :request, :stop],
      [:durable_streams, :request, :exception],
      [:durable_streams, :consumer, :batch],
      [:durable_streams, :consumer, :reconnect],
      [:durable_streams, :producer, :batch_sent],
      [:durable_streams, :producer, :duplicate]
    ]

    :telemetry.attach_many(
      "durable-streams-logger",
      events,
      &__MODULE__.handle_event/4,
      nil
    )
  end

  @doc false
  def handle_event(event, measurements, metadata, _config) do
    require Logger
    Logger.debug("#{inspect(event)} #{inspect(measurements)} #{inspect(metadata)}")
  end
end
```

---

## Application Setup

```elixir
defmodule DurableStreams.Application do
  @moduledoc false
  use Application

  @impl true
  def start(_type, _args) do
    children = [
      # HTTP connection pool
      {DurableStreams.Client, name: DurableStreams.Finch}
    ]

    opts = [strategy: :one_for_one, name: DurableStreams.Supervisor]
    Supervisor.start_link(children, opts)
  end
end
```

---

## Usage Examples

### Basic Operations

```elixir
# Create a stream handle
stream = DurableStreams.Stream.new("https://streams.example.com/my-stream",
  headers: %{"authorization" => "Bearer #{token}"},
  content_type: "application/json"
)

# Create the stream on the server
{:ok, stream} = DurableStreams.Stream.create(stream, ttl_seconds: 3600)

# Append data
:ok = DurableStreams.Stream.append(stream, %{event: "user_created", user_id: 123})

# Read all data (catch-up)
{:ok, items} = DurableStreams.Stream.read_json(stream, live: false)
IO.inspect(items)  # [%{"event" => "user_created", "user_id" => 123}]

# Delete stream
:ok = DurableStreams.Stream.delete(stream)
```

### Long-Running Consumer

```elixir
defmodule MyEventConsumer do
  @behaviour DurableStreams.Consumer

  @impl true
  def init(_args) do
    {:ok, %{processed: 0}}
  end

  @impl true
  def handle_batch(batch, state) do
    for item <- batch.items do
      process_event(item)
    end

    # Checkpoint next_offset for resumability
    # Note: Only save AFTER handle_batch returns {:ok, ...}
    save_offset(batch.next_offset)

    {:ok, %{state | processed: state.processed + length(batch.items)}}
  end

  @impl true
  def handle_error(error, state) do
    Logger.error("Consumer error: #{inspect(error)}")
    {:reconnect, state}
  end

  defp process_event(event), do: IO.inspect(event, label: "Event")
  defp save_offset(offset), do: :ok  # Persist to DB/file
end

# Start the consumer
{:ok, consumer} = DurableStreams.Consumer.start_link(
  stream: stream,
  callback_module: MyEventConsumer,
  live: :long_poll,
  offset: load_last_offset() || :start
)
```

### Broadway Pipeline

```elixir
defmodule MyBroadway do
  use Broadway

  def start_link(_opts) do
    stream = DurableStreams.Stream.new("https://streams.example.com/events",
      headers: %{"authorization" => fn -> get_auth_token() end}
    )

    Broadway.start_link(__MODULE__,
      name: __MODULE__,
      producer: [
        module: {DurableStreams.Broadway.Producer, [
          stream: stream,
          live: :long_poll,
          offset: :start
        ]},
        concurrency: 1
      ],
      processors: [
        default: [concurrency: System.schedulers_online() * 2]
      ],
      batchers: [
        database: [batch_size: 100, batch_timeout: 500],
        analytics: [batch_size: 1000, batch_timeout: 2000]
      ]
    )
  end

  @impl true
  def handle_message(_processor, message, _context) do
    event = message.data

    batcher = case event["type"] do
      "purchase" -> :database
      "pageview" -> :analytics
      _ -> :database
    end

    message
    |> Broadway.Message.update_data(&transform/1)
    |> Broadway.Message.put_batcher(batcher)
  end

  @impl true
  def handle_batch(:database, messages, _batch_info, _context) do
    # Bulk insert to database
    records = Enum.map(messages, & &1.data)
    MyRepo.insert_all(Events, records)
    messages
  end

  @impl true
  def handle_batch(:analytics, messages, _batch_info, _context) do
    # Send to analytics service
    events = Enum.map(messages, & &1.data)
    AnalyticsClient.track_batch(events)
    messages
  end

  defp transform(event), do: Map.put(event, :processed_at, DateTime.utc_now())
  defp get_auth_token(), do: MyAuth.get_token()
end
```

### Idempotent Producer

```elixir
# Start producer with auto-claim for serverless
{:ok, producer} = DurableStreams.Writer.start_link(
  stream: stream,
  producer_id: "order-processor-#{node()}",
  epoch: 0,
  auto_claim: true,
  max_batch_bytes: 1_048_576,  # 1MB
  linger_ms: 5,
  max_in_flight: 5,
  on_error: fn error ->
    Logger.error("Producer error: #{inspect(error)}")
  end
)

# Fire-and-forget writes (returns immediately)
:ok = DurableStreams.Writer.append(producer, %{order_id: 1, status: "created"})
:ok = DurableStreams.Writer.append(producer, %{order_id: 1, status: "paid"})
:ok = DurableStreams.Writer.append(producer, %{order_id: 1, status: "shipped"})

# Ensure delivery before shutdown
:ok = DurableStreams.Writer.flush(producer)
:ok = DurableStreams.Writer.close(producer)
```

### Streaming with Enumerable

```elixir
# Stream as Enumerable (lazy)
stream
|> DurableStreams.Stream.stream_json(live: false)
|> Stream.filter(&(&1["type"] == "purchase"))
|> Stream.take(100)
|> Enum.to_list()

# Process with Flow for parallel computation
stream
|> DurableStreams.Stream.stream_json(live: false)
|> Flow.from_enumerable()
|> Flow.partition(key: {:key, "user_id"})
|> Flow.reduce(fn -> %{} end, fn event, acc ->
  user_id = event["user_id"]
  Map.update(acc, user_id, 1, &(&1 + 1))
end)
|> Enum.to_list()
```

---

## Supervision Tree

```
Application
├── DurableStreams.Finch (HTTP connection pool)
├── ConsumerSupervisor (DynamicSupervisor)
│   ├── Consumer (stream A)
│   ├── Consumer (stream B)
│   └── ...
├── ProducerSupervisor (DynamicSupervisor)
│   ├── Writer (stream X)
│   ├── Writer (stream Y)
│   └── ...
└── Broadway pipelines (if using Broadway)
    ├── MyBroadway.Broadway
    └── ...
```

---

## Configuration

```elixir
# config/config.exs
config :durable_streams,
  finch_pool_size: 10,
  finch_pool_count: 1,
  default_backoff: [
    base_delay: 100,
    max_delay: 10_000,
    max_retries: 5
  ],
  telemetry_enabled: true

# Runtime configuration
config :durable_streams,
  default_headers: %{
    "user-agent" => "DurableStreams-Elixir/1.0"
  }
```

---

## Dependencies

```elixir
# mix.exs
defp deps do
  [
    {:finch, "~> 0.18"},       # HTTP client
    {:jason, "~> 1.4"},        # JSON encoding/decoding
    {:backoff, "~> 1.1"},      # Exponential backoff (Erlang)
    {:telemetry, "~> 1.2"},    # Telemetry for observability

    # Optional
    {:broadway, "~> 1.0", optional: true},  # Broadway integration
    {:gen_stage, "~> 1.2"},    # GenStage (included with Broadway)
  ]
end
```

---

## Design Rationale

### Why Finch over HTTPoison/Tesla?

- **Mint-based**: Process-less, composable HTTP client
- **Connection pooling**: Built-in pool management with HTTP/2 multiplexing
- **Streaming support**: Native streaming for SSE and chunked responses
- **Performance**: Lower memory overhead, better concurrency

### Why GenServer-based Consumer?

- **Lifecycle management**: Clean startup/shutdown with OTP semantics
- **Reconnection**: Built-in state machine for backoff/retry
- **Supervision**: Fits naturally into OTP supervision trees
- **Checkpointing**: Easy offset persistence between restarts

### Why GenStage Producer for Broadway?

- **Backpressure**: Demand-driven flow prevents overwhelming consumers
- **Batching**: Natural fit with Broadway's batch processing
- **Concurrency**: Configurable processor/batcher concurrency
- **Acknowledgements**: Broadway handles message lifecycle

### Why Separate Writer Module?

- **Fire-and-forget**: Different use case from request/response
- **Batching complexity**: Requires internal buffering and pipelining
- **Sequence coordination**: 409 retry handling needs dedicated state
- **Epoch management**: Restart/claim logic is writer-specific
- **Naming clarity**: "Producer" in Elixir/OTP means GenStage read-side; "Writer" clearly indicates write-side

---

## Future Enhancements

1. **Distributed Consumers** - Coordinate offset across nodes using pg/Horde
2. **Consumer Groups** - Kafka-style partition assignment
3. **Metrics Dashboard** - Phoenix LiveDashboard integration
4. **Schema Registry** - Avro/Protobuf schema validation
5. **Dead Letter Queue** - Failed message handling
6. **Compression** - gzip/zstd support for large payloads
