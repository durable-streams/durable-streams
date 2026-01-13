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

  ## Checkpointing

  The Consumer tracks the committed offset - the last successfully processed
  position. Use `committed_offset/1` to get this value for external persistence.

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
          # batch.data - the raw binary data
          # batch.next_offset - offset for next request
          # batch.up_to_date - true when caught up with stream tail
          for item <- parse_items(batch.data) do
            process_item(item)
          end
          {:ok, %{state | count: state.count + 1}}
        end

        @impl true
        def handle_error(error, state) do
          # Return :reconnect to retry, :stop to terminate
          {:reconnect, state}
        end
      end

  ## Starting a Consumer

      {:ok, pid} = DurableStreams.Consumer.start_link(
        stream: my_stream,
        callback: {MyConsumer, []},
        live: :long_poll,
        offset: "-1"
      )

  ## Options

  - `:stream` - A `DurableStreams.Stream` struct (required)
  - `:callback` - Tuple of `{Module, args}` where Module implements the Consumer behaviour
  - `:live` - Live mode: `false`, `:long_poll`, or `:sse` (default: `:long_poll`)
  - `:offset` - Starting offset (default: `"-1"` for beginning)
  - `:name` - GenServer name registration
  - `:backoff_base` - Initial backoff delay in ms (default: 1000)
  - `:backoff_max` - Maximum backoff delay in ms (default: 30000)
  """

  use GenServer
  require Logger

  alias DurableStreams.Stream

  # Behaviour callbacks

  @doc """
  Initialize the consumer state.

  Called when the Consumer starts. Return `{:ok, state}` to proceed
  or `{:stop, reason}` to abort startup.
  """
  @callback init(args :: term()) :: {:ok, state :: term()} | {:stop, reason :: term()}

  @doc """
  Handle a batch of data from the stream.

  Called when new data is received. The batch contains:
  - `data` - Raw binary data from the stream
  - `next_offset` - The offset to use for the next read
  - `up_to_date` - Boolean indicating if we've reached the stream tail

  Return `{:ok, new_state}` to continue consuming, or
  `{:stop, reason, state}` to terminate the consumer.
  """
  @callback handle_batch(batch :: Stream.read_chunk(), state :: term()) ::
              {:ok, state :: term()} | {:stop, reason :: term(), state :: term()}

  @doc """
  Handle errors during consumption.

  Called when a read fails or other error occurs. Return
  `{:reconnect, state}` to retry with backoff, or
  `{:stop, reason, state}` to terminate.
  """
  @callback handle_error(error :: term(), state :: term()) ::
              {:reconnect, state :: term()} | {:stop, reason :: term(), state :: term()}

  # Optional callback for when consumer becomes up-to-date
  @optional_callbacks [handle_up_to_date: 1]

  @doc """
  Called when the consumer catches up to the stream tail.

  Optional callback invoked when `up_to_date` becomes true.
  """
  @callback handle_up_to_date(state :: term()) :: {:ok, state :: term()}

  # Internal state
  defstruct [
    :stream,
    :callback_module,
    :callback_state,
    :live_mode,
    :committed_offset,
    :cursor,
    :backoff_base,
    :backoff_max,
    :backoff_current,
    :consecutive_errors,
    :poll_ref
  ]

  # Client API

  @doc """
  Start a Consumer process linked to the current process.

  See module documentation for options.
  """
  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(opts) do
    {gen_opts, consumer_opts} = Keyword.split(opts, [:name])
    GenServer.start_link(__MODULE__, consumer_opts, gen_opts)
  end

  @doc """
  Stop the consumer gracefully.
  """
  @spec stop(GenServer.server(), term()) :: :ok
  def stop(consumer, reason \\ :normal) do
    GenServer.stop(consumer, reason)
  end

  @doc """
  Get the last committed offset (safe for checkpointing).

  This offset represents the last batch that was successfully processed.
  Use this value when persisting offsets for resumption.
  """
  @spec committed_offset(GenServer.server()) :: String.t()
  def committed_offset(consumer) do
    GenServer.call(consumer, :get_committed_offset)
  end

  @doc """
  Get the current callback state.
  """
  @spec callback_state(GenServer.server()) :: term()
  def callback_state(consumer) do
    GenServer.call(consumer, :get_callback_state)
  end

  @doc """
  Pause consuming. The consumer will stop polling until resumed.
  """
  @spec pause(GenServer.server()) :: :ok
  def pause(consumer) do
    GenServer.call(consumer, :pause)
  end

  @doc """
  Resume consuming after a pause.
  """
  @spec resume(GenServer.server()) :: :ok
  def resume(consumer) do
    GenServer.call(consumer, :resume)
  end

  # GenServer callbacks

  @impl true
  def init(opts) do
    stream = Keyword.fetch!(opts, :stream)
    {callback_module, callback_args} = extract_callback(opts)
    live_mode = Keyword.get(opts, :live, :long_poll)
    offset = Keyword.get(opts, :offset, "-1")
    backoff_base = Keyword.get(opts, :backoff_base, 1_000)
    backoff_max = Keyword.get(opts, :backoff_max, 30_000)

    case callback_module.init(callback_args) do
      {:ok, callback_state} ->
        state = %__MODULE__{
          stream: stream,
          callback_module: callback_module,
          callback_state: callback_state,
          live_mode: live_mode,
          committed_offset: offset,
          cursor: nil,
          backoff_base: backoff_base,
          backoff_max: backoff_max,
          backoff_current: backoff_base,
          consecutive_errors: 0,
          poll_ref: nil
        }

        # Start polling
        {:ok, schedule_poll(state, 0)}

      {:stop, reason} ->
        {:stop, reason}
    end
  end

  @impl true
  def handle_call(:get_committed_offset, _from, state) do
    {:reply, state.committed_offset, state}
  end

  @impl true
  def handle_call(:get_callback_state, _from, state) do
    {:reply, state.callback_state, state}
  end

  @impl true
  def handle_call(:pause, _from, state) do
    # Cancel any pending poll
    if state.poll_ref, do: Process.cancel_timer(state.poll_ref)
    {:reply, :ok, %{state | poll_ref: nil}}
  end

  @impl true
  def handle_call(:resume, _from, state) do
    if state.poll_ref do
      # Already polling
      {:reply, :ok, state}
    else
      {:reply, :ok, schedule_poll(state, 0)}
    end
  end

  @impl true
  def handle_info(:poll, state) do
    state = %{state | poll_ref: nil}

    read_opts = [
      offset: state.committed_offset,
      live: state.live_mode
    ]

    case Stream.read(state.stream, read_opts) do
      {:ok, batch} ->
        handle_successful_read(batch, state)

      {:error, reason} ->
        handle_read_error(reason, state)
    end
  end

  @impl true
  def handle_info({:DOWN, _ref, :process, pid, reason}, state) do
    Logger.debug("Consumer received DOWN message: process #{inspect(pid)} terminated with #{inspect(reason)}")
    {:noreply, state}
  end

  @impl true
  def terminate(_reason, _state) do
    :ok
  end

  # Private functions

  defp handle_successful_read(batch, state) do
    # Reset backoff on success
    state = %{state | backoff_current: state.backoff_base, consecutive_errors: 0}

    # Only deliver batch if there's data
    if byte_size(batch.data) > 0 do
      deliver_batch(batch, state)
    else
      # No data but possibly up_to_date changed
      state = maybe_notify_up_to_date(batch.up_to_date, state)
      # Schedule next poll
      delay = if batch.up_to_date and state.live_mode == false, do: 1_000, else: 0
      {:noreply, schedule_poll(state, delay)}
    end
  end

  defp deliver_batch(batch, state) do
    case state.callback_module.handle_batch(batch, state.callback_state) do
      {:ok, new_callback_state} ->
        # Batch processed successfully - advance offset
        state = %{state |
          callback_state: new_callback_state,
          committed_offset: batch.next_offset
        }

        state = maybe_notify_up_to_date(batch.up_to_date, state)

        # Schedule next poll immediately unless we're up-to-date with no live mode
        delay = if batch.up_to_date and state.live_mode == false, do: 1_000, else: 0
        {:noreply, schedule_poll(state, delay)}

      {:stop, reason, new_callback_state} ->
        {:stop, reason, %{state | callback_state: new_callback_state}}
    end
  end

  defp handle_read_error(reason, state) do
    Logger.warning("Consumer read error: #{inspect(reason)}")

    case state.callback_module.handle_error(reason, state.callback_state) do
      {:reconnect, new_callback_state} ->
        # Calculate backoff with jitter
        delay = calculate_backoff(state)
        state = %{state |
          callback_state: new_callback_state,
          consecutive_errors: state.consecutive_errors + 1,
          backoff_current: min(state.backoff_current * 2, state.backoff_max)
        }
        {:noreply, schedule_poll(state, delay)}

      {:stop, reason, new_callback_state} ->
        {:stop, reason, %{state | callback_state: new_callback_state}}
    end
  end

  defp maybe_notify_up_to_date(true, state) do
    if function_exported?(state.callback_module, :handle_up_to_date, 1) do
      try do
        case state.callback_module.handle_up_to_date(state.callback_state) do
          {:ok, new_callback_state} ->
            %{state | callback_state: new_callback_state}

          other ->
            Logger.warning("handle_up_to_date returned unexpected value: #{inspect(other)}")
            state
        end
      rescue
        e ->
          Logger.error("handle_up_to_date raised #{inspect(e.__struct__)}: #{Exception.message(e)}")
          state
      end
    else
      state
    end
  end

  defp maybe_notify_up_to_date(false, state), do: state

  defp schedule_poll(state, delay) do
    ref = Process.send_after(self(), :poll, delay)
    %{state | poll_ref: ref}
  end

  defp calculate_backoff(state) do
    # Add jitter: 75-125% of current backoff
    jitter = 0.75 + :rand.uniform() * 0.5
    round(state.backoff_current * jitter)
  end

  # Extract callback module and args from opts
  # Supports both new `callback: {Module, args}` and legacy `callback_module:` format
  defp extract_callback(opts) do
    case Keyword.get(opts, :callback) do
      {module, args} when is_atom(module) ->
        {module, args}

      nil ->
        # Legacy format for backwards compatibility
        module = Keyword.fetch!(opts, :callback_module)
        args = Keyword.get(opts, :callback_args, [])
        {module, args}
    end
  end
end
