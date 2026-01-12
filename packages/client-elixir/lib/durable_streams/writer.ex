defmodule DurableStreams.Writer do
  @moduledoc """
  Fire-and-forget producer with exactly-once write semantics.

  Implements Kafka-style idempotent producer pattern:
  - Client-provided producer IDs (zero RTT overhead)
  - Client-declared epochs, server-validated fencing
  - Per-write sequence numbers for deduplication
  - Automatic batching and pipelining

  ## Exactly-Once Semantics

  The Writer uses `(producer_id, epoch, seq)` tuples to guarantee exactly-once
  delivery even in the presence of retries:

  - **producer_id**: Stable identifier for this producer (survives restarts)
  - **epoch**: Incremented on restart to fence old producers
  - **seq**: Per-epoch sequence number, auto-incremented

  If a write is retried due to network issues, the server uses these headers
  to deduplicate - returning 204 instead of 200 for duplicate writes.

  ## Example

      {:ok, writer} = DurableStreams.Writer.start_link(
        stream: my_stream,
        producer_id: "order-service-1",
        epoch: 0
      )

      # Fire-and-forget (returns immediately)
      :ok = DurableStreams.Writer.append(writer, data1)
      :ok = DurableStreams.Writer.append(writer, data2)

      # Wait for all pending writes
      :ok = DurableStreams.Writer.flush(writer)

      # Graceful shutdown
      :ok = DurableStreams.Writer.close(writer)

  ## Options

  - `:stream` - A `DurableStreams.Stream` struct (required)
  - `:producer_id` - Stable identifier for this producer (required)
  - `:epoch` - Starting epoch (default: 0), increment on restart
  - `:auto_claim` - On 403, automatically retry with epoch+1 (default: false)
  - `:max_batch_size` - Max items before sending batch (default: 100)
  - `:max_batch_bytes` - Max bytes before sending batch (default: 1MB)
  - `:linger_ms` - Max wait time before sending batch (default: 5ms)
  - `:max_in_flight` - Max concurrent batches (default: 5)
  - `:on_error` - Callback for errors: `fn error, items -> ... end`
  - `:name` - GenServer name registration

  ## Epoch Management

  When a writer restarts, it should increment its epoch to fence any
  zombie writers that might still be running with the old epoch:

      # On application start, load last known epoch and increment
      last_epoch = MyDB.get_producer_epoch("my-producer") || 0
      {:ok, writer} = Writer.start_link(
        stream: stream,
        producer_id: "my-producer",
        epoch: last_epoch + 1
      )
      MyDB.save_producer_epoch("my-producer", last_epoch + 1)

  Or use `:auto_claim` for simpler deployments where the server
  will tell you the current epoch on 403.
  """

  use GenServer
  require Logger

  alias DurableStreams.Stream

  @default_max_batch_size 100
  @default_max_batch_bytes 1_048_576  # 1MB
  @default_linger_ms 5
  @default_max_in_flight 5

  defstruct [
    :stream,
    :producer_id,
    :epoch,
    :auto_claim,
    :max_batch_size,
    :max_batch_bytes,
    :linger_ms,
    :max_in_flight,
    :on_error,
    # Runtime state
    :next_seq,
    :pending_items,
    :pending_bytes,
    :linger_timer,
    :in_flight,
    :flush_waiters,
    :closed
  ]

  # Client API

  @doc """
  Start a Writer process linked to the current process.

  See module documentation for options.
  """
  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(opts) do
    {gen_opts, writer_opts} = Keyword.split(opts, [:name])
    GenServer.start_link(__MODULE__, writer_opts, gen_opts)
  end

  @doc """
  Append data to the stream (fire-and-forget).

  Returns immediately. Data is batched and sent asynchronously.
  Errors are reported via the `:on_error` callback.

  The data will be sent with idempotent producer headers. If the
  write is retried due to network issues, the server will deduplicate.
  """
  @spec append(GenServer.server(), binary()) :: :ok
  def append(writer, data) when is_binary(data) do
    GenServer.cast(writer, {:append, data})
  end

  @doc """
  Append data and wait for confirmation.

  Unlike `append/2`, this blocks until the write is confirmed by the server.
  Returns `{:ok, result}` with the append result or `{:error, reason}`.
  """
  @spec append_sync(GenServer.server(), binary(), timeout()) ::
          {:ok, Stream.append_result()} | {:error, term()}
  def append_sync(writer, data, timeout \\ 30_000) when is_binary(data) do
    GenServer.call(writer, {:append_sync, data}, timeout)
  end

  @doc """
  Flush all pending and in-flight writes.

  Blocks until all writes are confirmed by the server.
  """
  @spec flush(GenServer.server(), timeout()) :: :ok | {:error, term()}
  def flush(writer, timeout \\ 30_000) do
    GenServer.call(writer, :flush, timeout)
  end

  @doc """
  Gracefully close the writer.

  Flushes pending writes before stopping.
  """
  @spec close(GenServer.server(), timeout()) :: :ok
  def close(writer, timeout \\ 30_000) do
    GenServer.call(writer, :close, timeout)
  end

  @doc """
  Get current epoch.
  """
  @spec epoch(GenServer.server()) :: non_neg_integer()
  def epoch(writer) do
    GenServer.call(writer, :get_epoch)
  end

  @doc """
  Get next sequence number.
  """
  @spec next_seq(GenServer.server()) :: non_neg_integer()
  def next_seq(writer) do
    GenServer.call(writer, :get_next_seq)
  end

  @doc """
  Get number of pending items (not yet sent).
  """
  @spec pending_count(GenServer.server()) :: non_neg_integer()
  def pending_count(writer) do
    GenServer.call(writer, :get_pending_count)
  end

  @doc """
  Get number of in-flight batches (sent but not confirmed).
  """
  @spec in_flight_count(GenServer.server()) :: non_neg_integer()
  def in_flight_count(writer) do
    GenServer.call(writer, :get_in_flight_count)
  end

  # GenServer callbacks

  @impl true
  def init(opts) do
    stream = Keyword.fetch!(opts, :stream)
    producer_id = Keyword.fetch!(opts, :producer_id)
    epoch = Keyword.get(opts, :epoch, 0)
    auto_claim = Keyword.get(opts, :auto_claim, false)
    max_batch_size = Keyword.get(opts, :max_batch_size, @default_max_batch_size)
    max_batch_bytes = Keyword.get(opts, :max_batch_bytes, @default_max_batch_bytes)
    linger_ms = Keyword.get(opts, :linger_ms, @default_linger_ms)
    max_in_flight = Keyword.get(opts, :max_in_flight, @default_max_in_flight)
    on_error = Keyword.get(opts, :on_error)

    state = %__MODULE__{
      stream: stream,
      producer_id: producer_id,
      epoch: epoch,
      auto_claim: auto_claim,
      max_batch_size: max_batch_size,
      max_batch_bytes: max_batch_bytes,
      linger_ms: linger_ms,
      max_in_flight: max_in_flight,
      on_error: on_error,
      next_seq: 0,
      pending_items: [],
      pending_bytes: 0,
      linger_timer: nil,
      in_flight: %{},  # ref => {items, seq_start, waiters}
      flush_waiters: [],
      closed: false
    }

    {:ok, state}
  end

  @impl true
  def handle_cast({:append, data}, state) do
    if state.closed do
      Logger.warning("Writer is closed, ignoring append")
      {:noreply, state}
    else
      state = add_to_batch(data, nil, state)
      {:noreply, maybe_send_batch(state)}
    end
  end

  @impl true
  def handle_call({:append_sync, data}, from, state) do
    if state.closed do
      {:reply, {:error, :closed}, state}
    else
      state = add_to_batch(data, from, state)
      {:noreply, maybe_send_batch(state)}
    end
  end

  @impl true
  def handle_call(:flush, from, state) do
    state = %{state | flush_waiters: [from | state.flush_waiters]}

    # Send pending batch immediately
    state = if length(state.pending_items) > 0 do
      send_batch(state)
    else
      state
    end

    # Check if already flushed
    if map_size(state.in_flight) == 0 and length(state.pending_items) == 0 do
      reply_to_flush_waiters(state)
      {:reply, :ok, %{state | flush_waiters: []}}
    else
      {:noreply, state}
    end
  end

  @impl true
  def handle_call(:close, from, state) do
    state = %{state | closed: true, flush_waiters: [from | state.flush_waiters]}

    # Send pending batch immediately
    state = if length(state.pending_items) > 0 do
      send_batch(state)
    else
      state
    end

    # Check if already flushed
    if map_size(state.in_flight) == 0 do
      reply_to_flush_waiters(state)
      {:stop, :normal, :ok, state}
    else
      {:noreply, state}
    end
  end

  @impl true
  def handle_call(:get_epoch, _from, state) do
    {:reply, state.epoch, state}
  end

  @impl true
  def handle_call(:get_next_seq, _from, state) do
    {:reply, state.next_seq, state}
  end

  @impl true
  def handle_call(:get_pending_count, _from, state) do
    {:reply, length(state.pending_items), state}
  end

  @impl true
  def handle_call(:get_in_flight_count, _from, state) do
    {:reply, map_size(state.in_flight), state}
  end

  @impl true
  def handle_info(:linger_timeout, state) do
    state = %{state | linger_timer: nil}
    {:noreply, send_batch(state)}
  end

  @impl true
  def handle_info({ref, result}, state) when is_reference(ref) do
    # Task completed
    Process.demonitor(ref, [:flush])
    handle_batch_result(ref, result, state)
  end

  @impl true
  def handle_info({:DOWN, ref, :process, _pid, reason}, state) do
    # Task crashed
    handle_batch_result(ref, {:error, reason}, state)
  end

  @impl true
  def terminate(_reason, state) do
    # Cancel linger timer
    if state.linger_timer, do: Process.cancel_timer(state.linger_timer)
    :ok
  end

  # Private functions

  defp add_to_batch(data, waiter, state) do
    item = {data, waiter}
    data_size = byte_size(data)

    state = %{state |
      pending_items: [item | state.pending_items],
      pending_bytes: state.pending_bytes + data_size
    }

    # Start linger timer if this is the first item
    if state.linger_timer == nil and length(state.pending_items) == 1 do
      timer = Process.send_after(self(), :linger_timeout, state.linger_ms)
      %{state | linger_timer: timer}
    else
      state
    end
  end

  defp maybe_send_batch(state) do
    cond do
      # Batch size limit reached
      length(state.pending_items) >= state.max_batch_size ->
        send_batch(state)

      # Batch bytes limit reached
      state.pending_bytes >= state.max_batch_bytes ->
        send_batch(state)

      # Too many in-flight batches
      map_size(state.in_flight) >= state.max_in_flight ->
        state

      true ->
        state
    end
  end

  defp send_batch(%{pending_items: []} = state), do: state

  defp send_batch(state) do
    # Cancel linger timer
    if state.linger_timer, do: Process.cancel_timer(state.linger_timer)

    # Get items in order (they were prepended)
    items = Enum.reverse(state.pending_items)
    seq_start = state.next_seq

    # For simplicity, we send items one at a time with incrementing seq
    # A more sophisticated implementation could batch JSON arrays
    task = Task.async(fn ->
      send_items_sequentially(state.stream, items, state.producer_id, state.epoch, seq_start)
    end)

    # Track in-flight batch
    waiters = items |> Enum.map(fn {_data, waiter} -> waiter end) |> Enum.filter(&(&1 != nil))
    in_flight = Map.put(state.in_flight, task.ref, {items, seq_start, waiters})

    %{state |
      pending_items: [],
      pending_bytes: 0,
      linger_timer: nil,
      next_seq: seq_start + length(items),
      in_flight: in_flight
    }
  end

  defp send_items_sequentially(stream, items, producer_id, epoch, seq_start) do
    results =
      items
      |> Enum.with_index(seq_start)
      |> Enum.reduce_while([], fn {{data, _waiter}, seq}, acc ->
        result = Stream.append(stream, data,
          producer_id: producer_id,
          producer_epoch: epoch,
          producer_seq: seq
        )

        case result do
          {:ok, append_result} ->
            {:cont, [{:ok, append_result} | acc]}

          {:error, {:stale_epoch, server_epoch}} ->
            {:halt, {:stale_epoch, server_epoch, Enum.reverse(acc)}}

          {:error, reason} ->
            {:halt, {:error, reason, Enum.reverse(acc)}}
        end
      end)

    case results do
      {:stale_epoch, server_epoch, _partial} ->
        {:error, {:stale_epoch, server_epoch}}

      {:error, reason, _partial} ->
        {:error, reason}

      completed when is_list(completed) ->
        {:ok, Enum.reverse(completed)}
    end
  end

  defp handle_batch_result(ref, result, state) do
    case Map.pop(state.in_flight, ref) do
      {nil, _} ->
        # Unknown ref, ignore
        {:noreply, state}

      {{items, _seq_start, waiters}, in_flight} ->
        state = %{state | in_flight: in_flight}

        case result do
          {:ok, results} ->
            # Reply to sync waiters
            Enum.zip(waiters, results)
            |> Enum.each(fn {waiter, item_result} ->
              if waiter, do: GenServer.reply(waiter, item_result)
            end)

          {:error, {:stale_epoch, server_epoch}} when state.auto_claim ->
            # Auto-claim: bump epoch and retry
            Logger.info("Writer auto-claiming epoch #{server_epoch + 1}")
            new_epoch = parse_epoch(server_epoch) + 1
            state = %{state | epoch: new_epoch, next_seq: 0}

            # Re-queue items for retry
            state = Enum.reduce(items, state, fn {data, waiter}, acc ->
              add_to_batch(data, waiter, acc)
            end)

            {:noreply, maybe_send_batch(state)}

          {:error, reason} ->
            # Notify error callback
            if state.on_error do
              item_data = Enum.map(items, fn {data, _waiter} -> data end)
              state.on_error.(reason, item_data)
            end

            # Reply to sync waiters with error
            Enum.each(waiters, fn waiter ->
              if waiter, do: GenServer.reply(waiter, {:error, reason})
            end)
        end

        # Check if we should notify flush waiters
        state =
          if map_size(state.in_flight) == 0 and length(state.pending_items) == 0 do
            reply_to_flush_waiters(state)
            %{state | flush_waiters: []}
          else
            state
          end

        # Check if we're closing and done
        if state.closed and map_size(state.in_flight) == 0 do
          {:stop, :normal, state}
        else
          {:noreply, state}
        end
    end
  end

  defp reply_to_flush_waiters(state) do
    Enum.each(state.flush_waiters, fn waiter ->
      GenServer.reply(waiter, :ok)
    end)
  end

  defp parse_epoch(nil), do: 0
  defp parse_epoch(epoch) when is_integer(epoch), do: epoch
  defp parse_epoch(epoch) when is_binary(epoch) do
    case Integer.parse(epoch) do
      {n, _} -> n
      :error -> 0
    end
  end
end
