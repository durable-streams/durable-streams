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
│   │   ├── idempotent_producer.ex      # Exactly-once producer
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
    offset: offset(),
    cursor: cursor(),
    up_to_date: boolean()
  }

  @type json_batch(t) :: %{
    items: [t],
    offset: offset(),
    cursor: cursor(),
    up_to_date: boolean()
  }

  @type byte_chunk :: %{
    data: binary(),
    offset: offset(),
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

      # Catch-up read (returns when up-to-date)
      {:ok, items} = DurableStreams.Stream.read_json(stream, live: false)

      # Live streaming with callback
      DurableStreams.Stream.subscribe_json(stream, fn batch ->
        IO.inspect(batch.items)
        :ok
      end)
  """
  @spec read_json(t(), keyword()) :: {:ok, [term()]} | {:error, term()}
  def read_json(stream, opts \\ [])

  @spec read_bytes(t(), keyword()) :: {:ok, binary()} | {:error, term()}
  def read_bytes(stream, opts \\ [])

  @spec read_text(t(), keyword()) :: {:ok, String.t()} | {:error, term()}
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
    :offset,
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

  @doc "Get current offset (for checkpointing)"
  def offset(consumer) do
    GenServer.call(consumer, :get_offset)
  end

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
          offset: offset,
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
  """
  use GenStage
  @behaviour Broadway.Producer

  alias Broadway.Message

  defstruct [
    :stream,
    :live_mode,
    :offset,
    :cursor,
    :ack_ref,
    :pending_demand,
    :buffer,
    :request_ref,
    :backoff,
    :receive_interval
  ]

  @impl true
  def init(opts) do
    stream = Keyword.fetch!(opts, :stream)
    live_mode = Keyword.get(opts, :live, :long_poll)
    offset = Keyword.get(opts, :offset, :start)
    receive_interval = Keyword.get(opts, :receive_interval, 5_000)

    state = %__MODULE__{
      stream: stream,
      live_mode: live_mode,
      offset: offset,
      cursor: nil,
      ack_ref: make_ref(),
      pending_demand: 0,
      buffer: [],
      request_ref: nil,
      backoff: :backoff.init(1_000, 30_000),
      receive_interval: receive_interval
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
    messages = Enum.map(batch.items, fn item ->
      %Message{
        data: item,
        metadata: %{
          offset: batch.offset,
          cursor: batch.cursor,
          up_to_date: batch.up_to_date
        },
        acknowledger: {__MODULE__, state.ack_ref, :ok}
      }
    end)

    new_state = %{state |
      offset: batch.offset,
      cursor: batch.cursor,
      pending_demand: max(0, state.pending_demand - length(messages)),
      backoff: :backoff.succeed(state.backoff)
    }

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

  # No-op acknowledger (Durable Streams tracks offset, not ack)
  @doc false
  def ack(_ack_ref, _successful, _failed), do: :ok

  defp maybe_fetch(%{pending_demand: 0} = state), do: {:noreply, [], state}
  defp maybe_fetch(%{request_ref: ref} = state) when ref != nil, do: {:noreply, [], state}
  defp maybe_fetch(state) do
    # Initiate async HTTP request
    # Store request_ref in state
    # ...
    {:noreply, [], state}
  end
end
```

### 5. Idempotent Producer

```elixir
defmodule DurableStreams.IdempotentProducer do
  @moduledoc """
  Fire-and-forget producer with exactly-once write semantics.

  Implements Kafka-style idempotent producer pattern:
  - Client-provided producer IDs (zero RTT overhead)
  - Client-declared epochs, server-validated fencing
  - Per-batch sequence numbers for deduplication
  - Automatic batching and pipelining

  ## Example

      {:ok, producer} = DurableStreams.IdempotentProducer.start_link(
        stream: my_stream,
        producer_id: "order-service-1",
        epoch: 0,
        auto_claim: true
      )

      # Fire-and-forget (returns immediately)
      :ok = DurableStreams.IdempotentProducer.append(producer, %{event: "created"})
      :ok = DurableStreams.IdempotentProducer.append(producer, %{event: "updated"})

      # Wait for all pending writes
      :ok = DurableStreams.IdempotentProducer.flush(producer)

      # Graceful shutdown
      :ok = DurableStreams.IdempotentProducer.close(producer)

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
  """
  @spec request(Finch.Request.t(), atom(), keyword()) ::
    {:ok, Finch.Response.t()} | {:error, term()}
  def request(req, finch_name \\ DurableStreams.Finch, opts \\ []) do
    backoff_opts = Keyword.get(opts, :backoff, [])
    max_retries = Keyword.get(backoff_opts, :max_retries, 5)
    base_delay = Keyword.get(backoff_opts, :base_delay, 100)
    max_delay = Keyword.get(backoff_opts, :max_delay, 10_000)

    do_request_with_retry(req, finch_name, 0, max_retries, base_delay, max_delay)
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

  defp do_request_with_retry(req, finch_name, attempt, max_retries, base_delay, max_delay) do
    start_time = System.monotonic_time()

    :telemetry.execute(
      [:durable_streams, :request, :start],
      %{system_time: System.system_time()},
      %{method: req.method, url: req.path, attempt: attempt}
    )

    case Finch.request(req, finch_name) do
      {:ok, %{status: status} = resp} when status < 500 ->
        duration = System.monotonic_time() - start_time
        :telemetry.execute(
          [:durable_streams, :request, :stop],
          %{duration: duration},
          %{method: req.method, url: req.path, status: status}
        )
        {:ok, resp}

      {:ok, %{status: status} = resp} when attempt < max_retries ->
        # 5xx - retry with backoff
        delay = calculate_delay(attempt, base_delay, max_delay)
        Process.sleep(delay)
        do_request_with_retry(req, finch_name, attempt + 1, max_retries, base_delay, max_delay)

      {:ok, resp} ->
        {:error, {:server_error, resp.status, resp.body}}

      {:error, reason} when attempt < max_retries ->
        # Network error - retry with backoff
        delay = calculate_delay(attempt, base_delay, max_delay)
        Process.sleep(delay)
        do_request_with_retry(req, finch_name, attempt + 1, max_retries, base_delay, max_delay)

      {:error, reason} ->
        {:error, reason}
    end
  end

  defp calculate_delay(attempt, base_delay, max_delay) do
    # Exponential backoff with jitter
    delay = base_delay * :math.pow(2, attempt) |> round()
    jitter = :rand.uniform(div(delay, 4))
    min(delay + jitter, max_delay)
  end
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
  """

  defstruct [:buffer, :current_event, :current_data]

  @type t :: %__MODULE__{
    buffer: binary(),
    current_event: String.t() | nil,
    current_data: [binary()]
  }

  @type event ::
    {:data, term()} |
    {:control, %{stream_next_offset: String.t(), stream_cursor: String.t()}}

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
  """
  @spec parse(t(), binary()) :: {[event()], t()}
  def parse(state, chunk) do
    buffer = state.buffer <> chunk
    parse_lines(buffer, state.current_event, state.current_data, [])
  end

  defp parse_lines(buffer, event, data, events) do
    case String.split(buffer, "\n", parts: 2) do
      [line, rest] ->
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
  defp parse_line("data: " <> data), do: {:data, data}
  defp parse_line("data:" <> data), do: {:data, data}
  defp parse_line(""), do: :empty
  defp parse_line(":" <> _comment), do: :ignore
  defp parse_line(_other), do: :ignore

  defp finalize_event("data", data_lines) do
    json = Enum.join(data_lines, "\n")
    {:data, Jason.decode!(json)}
  end

  defp finalize_event("control", data_lines) do
    json = Enum.join(data_lines, "\n")
    control = Jason.decode!(json)
    {:control, %{
      stream_next_offset: control["streamNextOffset"],
      stream_cursor: control["streamCursor"],
      up_to_date: control["upToDate"] || false
    }}
  end
end
```

---

## Error Types

```elixir
defmodule DurableStreams.Error do
  @moduledoc """
  Error types for Durable Streams operations.
  """

  defmodule NotFound do
    defexception [:url, :message]

    @impl true
    def message(%{url: url}) do
      "Stream not found: #{url}"
    end
  end

  defmodule Conflict do
    defexception [:url, :reason, :message]

    @impl true
    def message(%{url: url, reason: reason}) do
      "Conflict on #{url}: #{reason}"
    end
  end

  defmodule StaleEpoch do
    defexception [:current_epoch, :message]

    @impl true
    def message(%{current_epoch: epoch}) do
      "Producer epoch is stale. Server epoch: #{epoch}. Call restart/1 or create new producer."
    end
  end

  defmodule SequenceGap do
    defexception [:expected_seq, :received_seq, :message]

    @impl true
    def message(%{expected_seq: expected, received_seq: received}) do
      "Sequence gap: expected #{expected}, received #{received}"
    end
  end

  defmodule BadRequest do
    defexception [:url, :details, :message]
  end

  defmodule RateLimited do
    defexception [:url, :retry_after, :message]
  end

  defmodule ServerError do
    defexception [:url, :status, :body, :message]
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

    # Checkpoint offset for resumability
    save_offset(batch.offset)

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
{:ok, producer} = DurableStreams.IdempotentProducer.start_link(
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
:ok = DurableStreams.IdempotentProducer.append(producer, %{order_id: 1, status: "created"})
:ok = DurableStreams.IdempotentProducer.append(producer, %{order_id: 1, status: "paid"})
:ok = DurableStreams.IdempotentProducer.append(producer, %{order_id: 1, status: "shipped"})

# Ensure delivery before shutdown
:ok = DurableStreams.IdempotentProducer.flush(producer)
:ok = DurableStreams.IdempotentProducer.close(producer)
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
│   ├── IdempotentProducer (stream X)
│   ├── IdempotentProducer (stream Y)
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

### Why Separate Idempotent Producer?

- **Fire-and-forget**: Different use case from request/response
- **Batching complexity**: Requires internal buffering and pipelining
- **Sequence coordination**: 409 retry handling needs dedicated state
- **Epoch management**: Restart/claim logic is producer-specific

---

## Future Enhancements

1. **Distributed Consumers** - Coordinate offset across nodes using pg/Horde
2. **Consumer Groups** - Kafka-style partition assignment
3. **Metrics Dashboard** - Phoenix LiveDashboard integration
4. **Schema Registry** - Avro/Protobuf schema validation
5. **Dead Letter Queue** - Failed message handling
6. **Compression** - gzip/zstd support for large payloads
