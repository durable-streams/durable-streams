defmodule DurableStreams.HTTP.Finch do
  @moduledoc false
  # Internal: Finch-based HTTP client with true SSE streaming support.
  # Used automatically when Finch is available and SSE mode is requested.

  require Logger

  @finch_name DurableStreams.Finch

  @doc """
  Check if Finch is available.
  """
  def available? do
    Code.ensure_loaded?(Finch)
  end

  @doc """
  Get the Finch process name used by this library.
  """
  def finch_name, do: @finch_name

  @doc """
  Start the Finch connection pool.
  Called by the Application supervisor when Finch is available.
  """
  def child_spec(_opts) do
    if available?() do
      Finch.child_spec(name: @finch_name)
    else
      # Return a dummy spec that does nothing
      %{id: __MODULE__, start: {Function, :identity, [:ignore]}}
    end
  end

  @doc """
  Make an SSE streaming request with incremental event delivery.

  Calls `on_event` for each SSE event as it arrives. Returns when the
  stream ends or timeout is reached.

  ## Options

  - `:timeout` - Request timeout in milliseconds (default: 30000)
  - `:offset` - Starting offset for the stream
  - `:halt_on_up_to_date` - Internal/testing only. Halt after receiving events
    when stream reports up-to-date. Used by conformance tests to terminate
    SSE connections that would otherwise block indefinitely.
  - `:halt_on_up_to_date_immediate` - Internal/testing only. Halt immediately
    when up-to-date, even with zero events. For tests verifying empty streams.

  ## Callback

  The `on_event` callback receives `{:event, data, next_offset, up_to_date}`
  for each event, or `{:done, next_offset, up_to_date}` when complete.

  Returns `{:ok, final_state}` or `{:error, reason}`.
  """
  @spec stream_sse(String.t(), [{String.t(), String.t()}], keyword(), function()) ::
          {:ok, map()} | {:error, term()}
  def stream_sse(url, headers, opts, on_event) when is_function(on_event, 1) do
    unless available?() do
      {:error, :finch_not_available}
    else
      timeout = Keyword.get(opts, :timeout, 30_000)
      halt_on_up_to_date = Keyword.get(opts, :halt_on_up_to_date, false)
      halt_on_up_to_date_immediate = Keyword.get(opts, :halt_on_up_to_date_immediate, false)
      request = Finch.build(:get, url, headers)

      initial_acc = %{
        status: nil,
        headers: [],
        buffer: "",
        next_offset: nil,
        up_to_date: false,
        events_delivered: 0,
        error: nil,
        on_event: on_event,
        halt_on_up_to_date: halt_on_up_to_date,
        halt_on_up_to_date_immediate: halt_on_up_to_date_immediate
      }

      # Use Finch.stream_while for SSE - it supports {:cont, acc} / {:halt, acc} returns
      # which we need to halt early on error status codes
      result =
        try do
          Finch.stream_while(
            request,
            @finch_name,
            initial_acc,
            &handle_stream_message/2,
            receive_timeout: timeout
          )
        rescue
          e -> {:error, {:exception, Exception.message(e)}}
        end

      case result do
        {:ok, acc} ->
          # Check for error status codes before treating as success
          cond do
            acc.status == 404 ->
              {:error, :not_found}

            acc.status == 400 ->
              {:error, {:bad_request, ""}}

            acc.status == 410 ->
              earliest = get_header(acc.headers, "stream-earliest-offset")
              {:error, {:gone, earliest}}

            acc.status != nil and acc.status >= 400 ->
              {:error, {:unexpected_status, acc.status, ""}}

            acc.error != nil ->
              # Parse error encountered during SSE processing
              {:error, acc.error}

            true ->
              # Success - flush any remaining buffer
              acc = flush_buffer(acc)
              # Check for errors after flushing
              if acc.error != nil do
                {:error, acc.error}
              else
                {:ok, %{
                  next_offset: acc.next_offset,
                  up_to_date: acc.up_to_date,
                  events_delivered: acc.events_delivered
                }}
              end
          end

        {:error, %Finch.Error{reason: :request_timeout}} ->
          # Timeout is normal for SSE - return what we have
          {:ok, %{next_offset: nil, up_to_date: false, events_delivered: 0}}

        {:error, %Finch.Error{reason: reason}} ->
          {:error, {:connection_error, reason}}

        {:error, reason} ->
          {:error, reason}
      end
    end
  end

  # Handle streaming messages from Finch
  defp handle_stream_message({:status, status}, acc) when status >= 400 do
    # Error status - halt immediately, don't try to parse error body as SSE
    {:halt, %{acc | status: status}}
  end

  defp handle_stream_message({:status, status}, acc) do
    {:cont, %{acc | status: status}}
  end

  defp handle_stream_message({:headers, headers}, acc) do
    # Extract next_offset from headers if present
    next_offset = get_header(headers, "stream-next-offset")
    up_to_date = get_header(headers, "stream-up-to-date") == "true"
    {:cont, %{acc | headers: headers, next_offset: next_offset, up_to_date: up_to_date}}
  end

  defp handle_stream_message({:data, chunk}, acc) do
    # Append chunk to buffer and parse any complete events
    buffer = acc.buffer <> chunk
    {events, remaining_buffer} = parse_sse_events(buffer)

    # Deliver each event immediately
    acc = Enum.reduce(events, acc, fn event, acc ->
      deliver_event(event, acc)
    end)

    new_acc = %{acc | buffer: remaining_buffer}

    # Halt when up_to_date if configured
    # - halt_on_up_to_date_immediate: halt as soon as up_to_date (even with 0 events)
    # - halt_on_up_to_date: only halt if we've received some data
    should_halt = new_acc.up_to_date and (
      new_acc.halt_on_up_to_date_immediate or
      (new_acc.halt_on_up_to_date and new_acc.events_delivered > 0)
    )

    if should_halt do
      {:halt, new_acc}
    else
      {:cont, new_acc}
    end
  end

  defp handle_stream_message({:trailers, _trailers}, acc) do
    {:cont, acc}
  end

  # Flush any remaining complete events from buffer
  defp flush_buffer(acc) do
    {events, _remaining} = parse_sse_events(acc.buffer)
    Enum.reduce(events, acc, fn event, acc ->
      deliver_event(event, acc)
    end)
  end

  # Deliver a single SSE event to the callback
  defp deliver_event(%{type: "control", data: data}, acc) do
    # Control events update stream metadata
    # Format: {"streamNextOffset": "...", "upToDate": true/false}
    # Empty or malformed control events are parse errors
    if data == "" or data == nil do
      %{acc | error: {:parse_error, "Empty control event data"}}
    else
      case parse_control_data(data) do
        {:ok, control} when is_map(control) ->
          next_offset = control["streamNextOffset"] || acc.next_offset
          up_to_date = control["upToDate"] || acc.up_to_date
          %{acc | next_offset: next_offset, up_to_date: up_to_date}

        {:ok, _non_map} ->
          %{acc | error: {:parse_error, "Control event data is not a JSON object"}}

        {:error, _reason} ->
          %{acc | error: {:parse_error, "Malformed control event JSON: #{data}"}}
      end
    end
  end

  defp deliver_event(%{type: "data", data: data, id: id}, acc) do
    # Data event - deliver to callback
    next_offset = id || acc.next_offset
    acc.on_event.({:event, data, next_offset, acc.up_to_date})
    %{acc | next_offset: next_offset, events_delivered: acc.events_delivered + 1}
  end

  defp deliver_event(%{type: "message", data: data, id: id}, acc) do
    # Default SSE event type is "message" - treat as data
    next_offset = id || acc.next_offset
    acc.on_event.({:event, data, next_offset, acc.up_to_date})
    %{acc | next_offset: next_offset, events_delivered: acc.events_delivered + 1}
  end

  defp deliver_event(%{type: _unknown_type, data: _data, id: _id}, acc) do
    # Ignore unknown event types (as per SSE spec, forward compatibility)
    acc
  end

  # Parse SSE events from buffer, returning {complete_events, remaining_buffer}
  defp parse_sse_events(buffer) do
    # SSE events are separated by double newlines
    parts = String.split(buffer, ~r/\r?\n\r?\n/, parts: :infinity)

    case parts do
      [single] ->
        # No complete events yet
        {[], single}

      multiple ->
        # Last part may be incomplete
        {complete, [incomplete]} = Enum.split(multiple, -1)
        events = Enum.map(complete, &parse_single_event/1) |> Enum.reject(&is_nil/1)
        {events, incomplete}
    end
  end

  # Parse a single SSE event block
  defp parse_single_event(""), do: nil

  defp parse_single_event(block) do
    lines = String.split(block, ~r/\r?\n/)

    Enum.reduce(lines, %{type: "message", data: [], id: nil}, fn line, event ->
      cond do
        String.starts_with?(line, "event:") ->
          %{event | type: String.trim(String.slice(line, 6..-1//1))}

        String.starts_with?(line, "data:") ->
          data_line = String.slice(line, 5..-1//1)
          # Remove leading space if present (SSE spec)
          data_line = if String.starts_with?(data_line, " "), do: String.slice(data_line, 1..-1//1), else: data_line
          %{event | data: [data_line | event.data]}

        String.starts_with?(line, "id:") ->
          %{event | id: String.trim(String.slice(line, 3..-1//1))}

        true ->
          event
      end
    end)
    |> finalize_event()
  end

  defp finalize_event(%{data: []} = _event), do: nil

  defp finalize_event(%{data: data_lines} = event) do
    # SSE data lines are joined with newlines
    data = data_lines |> Enum.reverse() |> Enum.join("\n")
    %{event | data: data}
  end

  defp parse_control_data(data) when is_binary(data) do
    DurableStreams.JSON.decode(data)
  end

  defp parse_control_data(_), do: {:error, :invalid_control}

  defp get_header(headers, name) do
    name_lower = String.downcase(name)
    Enum.find_value(headers, fn {k, v} ->
      if String.downcase(k) == name_lower, do: v
    end)
  end
end
