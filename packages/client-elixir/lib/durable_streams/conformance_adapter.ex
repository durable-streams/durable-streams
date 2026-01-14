defmodule DurableStreams.ConformanceAdapter do
  @moduledoc """
  Conformance test adapter for the Durable Streams Elixir client.

  Communicates with the test runner via JSON-line protocol over stdin/stdout.
  """

  require Logger
  alias DurableStreams.{Client, Stream, Writer, JSON}

  @client_name "durable-streams-elixir"
  @client_version "0.1.0"

  # State
  defmodule State do
    defstruct [
      :server_url,
      :client,
      :stream_content_types,
      :dynamic_headers,
      :dynamic_params
    ]
  end

  def main(_args) do
    # Start the application (needed for Finch/SSE support)
    Application.ensure_all_started(:durable_streams)

    # Remove the default logger handler that writes to stdout
    # and add one that writes to stderr
    case :logger.get_handler_config(:default) do
      {:ok, handler_config} ->
        :logger.remove_handler(:default)
        new_config = put_in(handler_config.config[:type], :standard_error)
        :logger.add_handler(:default, :logger_std_h, new_config)
      _ ->
        :ok
    end

    state = %State{
      stream_content_types: %{},
      dynamic_headers: %{},
      dynamic_params: %{}
    }

    # Set UTF-8 encoding for stdin/stdout
    # Binary data is base64 encoded before output, so UTF-8 works for all cases
    :io.setopts(:standard_io, encoding: :unicode)

    loop(state)
  end

  defp loop(state) do
    case IO.gets("") do
      :eof ->
        :ok

      {:error, _reason} ->
        :ok

      line when is_binary(line) ->
        line = String.trim(line)

        if line == "" do
          loop(state)
        else
          case JSON.decode(line) do
            {:ok, command} ->
              try do
                {result, new_state} = handle_command(command, state)
                output = JSON.encode!(result)
                :ok = IO.puts(output)

                if command["type"] == "shutdown" do
                  :ok
                else
                  loop(new_state)
                end
              rescue
                e ->
                  result = error_result(command["type"] || "unknown", "INTERNAL_ERROR", Exception.message(e))
                  IO.puts(JSON.encode!(result))
                  loop(state)
              catch
                :exit, reason ->
                  result = error_result(command["type"] || "unknown", "INTERNAL_ERROR", "Process exit: #{inspect(reason)}")
                  IO.puts(JSON.encode!(result))
                  loop(state)
                kind, reason ->
                  result = error_result(command["type"] || "unknown", "INTERNAL_ERROR", "#{kind}: #{inspect(reason)}")
                  IO.puts(JSON.encode!(result))
                  loop(state)
              end

            {:error, _} ->
              result = error_result("unknown", "PARSE_ERROR", "Failed to parse command")
              IO.puts(JSON.encode!(result))
              loop(state)
          end
        end
    end
  end

  defp handle_command(%{"type" => "init"} = cmd, %State{} = state) do
    server_url = cmd["serverUrl"]
    client = Client.new(server_url)

    new_state = %{
      state
      | server_url: server_url,
        client: client,
        stream_content_types: %{},
        dynamic_headers: %{},
        dynamic_params: %{}
    }

    result = %{
      "type" => "init",
      "success" => true,
      "clientName" => @client_name,
      "clientVersion" => @client_version,
      "features" => %{
        "batching" => true,
        "sse" => DurableStreams.HTTP.Finch.available?(),  # True SSE requires Finch
        "longPoll" => true,
        "streaming" => true,
        "dynamicHeaders" => true
      }
    }

    {result, new_state}
  end

  defp handle_command(%{"type" => "create"} = cmd, state) do
    path = cmd["path"]
    # Only use explicit content-type, or default to application/octet-stream for the server
    explicit_content_type = cmd["contentType"]
    content_type = explicit_content_type || "application/octet-stream"
    ttl_seconds = cmd["ttlSeconds"]
    expires_at = cmd["expiresAt"]
    headers = cmd["headers"] || %{}

    stream =
      state.client
      |> Client.stream(path)
      |> Stream.set_content_type(content_type)

    opts =
      [content_type: content_type, headers: headers]
      |> maybe_add_opt(:ttl_seconds, ttl_seconds)
      |> maybe_add_opt(:expires_at, expires_at)

    # Check if exists first
    already_exists =
      case Stream.head(stream) do
        {:ok, _} -> true
        _ -> false
      end

    case Stream.create(stream, opts) do
      {:ok, _stream} ->
        # Get the offset after creation
        case Stream.head(stream) do
          {:ok, %{next_offset: offset}} ->
            # Only store explicitly provided content-type (for binary detection)
            new_state =
              if explicit_content_type do
                put_in(state.stream_content_types[path], explicit_content_type)
              else
                state
              end
            status = if already_exists, do: 200, else: 201

            result = %{
              "type" => "create",
              "success" => true,
              "status" => status,
              "offset" => offset
            }

            {result, new_state}

          {:error, reason} ->
            {error_result("create", "INTERNAL_ERROR", inspect(reason)), state}
        end

      {:error, reason} ->
        {map_error("create", reason), state}
    end
  end

  defp handle_command(%{"type" => "connect"} = cmd, state) do
    path = cmd["path"]
    headers = cmd["headers"] || %{}

    stream = Client.stream(state.client, path)

    case Stream.head(stream, headers: headers) do
      {:ok, %{next_offset: offset, content_type: _content_type}} ->
        # Don't update content-type from server response - only use explicit content-type from create
        result = %{
          "type" => "connect",
          "success" => true,
          "status" => 200,
          "offset" => offset
        }

        {result, state}

      {:error, :not_found} ->
        {map_error("connect", :not_found, path), state}

      {:error, reason} ->
        {map_error("connect", reason), state}
    end
  end

  defp handle_command(%{"type" => "append"} = cmd, state) do
    path = cmd["path"]
    data = cmd["data"] || ""
    binary = cmd["binary"] || false
    seq = cmd["seq"]
    headers = cmd["headers"] || %{}

    # Decode base64 if binary
    data =
      if binary do
        Base.decode64!(data)
      else
        data
      end

    # Resolve dynamic headers
    {resolved_headers, new_state} = resolve_dynamic_headers(state)
    {resolved_params, new_state} = resolve_dynamic_params(new_state)

    merged_headers = Map.merge(resolved_headers, headers)

    content_type = state.stream_content_types[path] || "application/octet-stream"

    stream =
      state.client
      |> Client.stream(path)
      |> Stream.set_content_type(content_type)

    opts =
      [headers: merged_headers]
      |> maybe_add_opt(:seq, seq)

    case Stream.append(stream, data, opts) do
      {:ok, %{next_offset: offset}} ->
        result =
          %{
            "type" => "append",
            "success" => true,
            "status" => 200,
            "offset" => offset
          }
          |> maybe_add_headers_sent(resolved_headers)
          |> maybe_add_params_sent(resolved_params)

        {result, new_state}

      {:error, :not_found} ->
        {map_error("append", :not_found, path), new_state}

      {:error, reason} ->
        {map_error("append", reason), new_state}
    end
  end

  defp handle_command(%{"type" => "read"} = cmd, state) do
    path = cmd["path"]
    offset = cmd["offset"] || "-1"
    live = cmd["live"]
    # Use slightly shorter timeout than the runner's 30s command timeout
    # to ensure we respond before the runner times out
    default_timeout = if live == "sse", do: 25_000, else: 5000
    timeout_ms = cmd["timeoutMs"] || default_timeout
    max_chunks = cmd["maxChunks"] || 100
    wait_for_up_to_date = cmd["waitForUpToDate"] || false
    headers = cmd["headers"] || %{}

    # Resolve dynamic headers
    {resolved_headers, new_state} = resolve_dynamic_headers(state)
    {resolved_params, new_state} = resolve_dynamic_params(new_state)

    merged_headers = Map.merge(resolved_headers, headers)

    stream = Client.stream(state.client, path)

    live_mode =
      case live do
        "long-poll" -> :long_poll
        "sse" -> :sse
        false -> false
        nil -> false
        _ -> false
      end

    opts = [
      offset: offset,
      live: live_mode,
      timeout: timeout_ms,
      headers: merged_headers
    ]

    # Read chunks - first try to catch initial errors
    case read_chunks(stream, opts, max_chunks, wait_for_up_to_date, live_mode) do
      {:ok, chunks, final_offset, up_to_date, status} ->
        result =
          %{
            "type" => "read",
            "success" => true,
            "status" => status,
            "chunks" => chunks,
            "offset" => final_offset,
            "upToDate" => up_to_date
          }
          |> maybe_add_headers_sent(resolved_headers)
          |> maybe_add_params_sent(resolved_params)

        {result, new_state}

      {:error, :not_found} ->
        {map_error("read", :not_found, path), new_state}

      {:error, reason} ->
        {map_error("read", reason), new_state}
    end
  end

  defp handle_command(%{"type" => "head"} = cmd, state) do
    path = cmd["path"]
    headers = cmd["headers"] || %{}

    stream = Client.stream(state.client, path)

    case Stream.head(stream, headers: headers) do
      {:ok, %{next_offset: offset, content_type: content_type}} ->
        result = %{
          "type" => "head",
          "success" => true,
          "status" => 200,
          "offset" => offset,
          "contentType" => content_type
        }

        {result, state}

      {:error, :not_found} ->
        {map_error("head", :not_found, path), state}

      {:error, reason} ->
        {map_error("head", reason), state}
    end
  end

  defp handle_command(%{"type" => "delete"} = cmd, state) do
    path = cmd["path"]
    headers = cmd["headers"] || %{}

    stream = Client.stream(state.client, path)

    case Stream.delete(stream, headers: headers) do
      :ok ->
        new_state = %{state | stream_content_types: Map.delete(state.stream_content_types, path)}

        result = %{
          "type" => "delete",
          "success" => true,
          "status" => 200
        }

        {result, new_state}

      {:error, :not_found} ->
        {map_error("delete", :not_found, path), state}

      {:error, reason} ->
        {map_error("delete", reason), state}
    end
  end

  defp handle_command(%{"type" => "idempotent-append"} = cmd, state) do
    path = cmd["path"]
    data = cmd["data"] || ""
    producer_id = cmd["producerId"]
    epoch = cmd["epoch"] || 0
    auto_claim = cmd["autoClaim"] || false

    content_type = state.stream_content_types[path] || "application/octet-stream"

    stream =
      state.client
      |> Client.stream(path)
      |> Stream.set_content_type(content_type)

    do_idempotent_append(stream, data, producer_id, epoch, 0, auto_claim, state)
  end

  defp handle_command(%{"type" => "idempotent-append-batch"} = cmd, state) do
    path = cmd["path"]
    items = cmd["items"] || []
    producer_id = cmd["producerId"]
    epoch = cmd["epoch"] || 0
    auto_claim = cmd["autoClaim"] || false
    _max_in_flight = cmd["maxInFlight"] || 1

    content_type = state.stream_content_types[path] || "application/octet-stream"

    stream =
      state.client
      |> Client.stream(path)
      |> Stream.set_content_type(content_type)

    # Check if this is a JSON stream (need to normalize JSON data)
    is_json = String.starts_with?(String.downcase(content_type), "application/json")

    do_idempotent_batch(stream, items, producer_id, epoch, auto_claim, is_json, state)
  end

  defp handle_command(%{"type" => "set-dynamic-header"} = cmd, state) do
    name = cmd["name"]
    value_type = cmd["valueType"]
    initial_value = cmd["initialValue"]

    dynamic_value = %{
      type: value_type,
      counter: 0,
      token_value: initial_value
    }

    new_state = put_in(state.dynamic_headers[name], dynamic_value)

    result = %{
      "type" => "set-dynamic-header",
      "success" => true
    }

    {result, new_state}
  end

  defp handle_command(%{"type" => "set-dynamic-param"} = cmd, state) do
    name = cmd["name"]
    value_type = cmd["valueType"]

    dynamic_value = %{
      type: value_type,
      counter: 0
    }

    new_state = put_in(state.dynamic_params[name], dynamic_value)

    result = %{
      "type" => "set-dynamic-param",
      "success" => true
    }

    {result, new_state}
  end

  defp handle_command(%{"type" => "clear-dynamic"}, state) do
    new_state = %{state | dynamic_headers: %{}, dynamic_params: %{}}

    result = %{
      "type" => "clear-dynamic",
      "success" => true
    }

    {result, new_state}
  end

  defp handle_command(%{"type" => "benchmark"} = cmd, state) do
    iteration_id = cmd["iterationId"]
    operation = cmd["operation"]

    try do
      {duration_ns, metrics} = run_benchmark(operation, state)

      result =
        %{
          "type" => "benchmark",
          "success" => true,
          "iterationId" => iteration_id,
          "durationNs" => Integer.to_string(duration_ns)
        }
        |> maybe_add_metrics(metrics)

      {result, state}
    rescue
      e ->
        result = %{
          "type" => "benchmark",
          "success" => false,
          "iterationId" => iteration_id,
          "error" => Exception.message(e)
        }
        {result, state}
    catch
      :exit, reason ->
        result = %{
          "type" => "benchmark",
          "success" => false,
          "iterationId" => iteration_id,
          "error" => "Process exit: #{inspect(reason)}"
        }
        {result, state}
      kind, reason ->
        result = %{
          "type" => "benchmark",
          "success" => false,
          "iterationId" => iteration_id,
          "error" => "#{kind}: #{inspect(reason)}"
        }
        {result, state}
    end
  end

  defp handle_command(%{"type" => "shutdown"}, state) do
    result = %{
      "type" => "shutdown",
      "success" => true
    }

    {result, state}
  end

  defp handle_command(%{"type" => "validate"} = cmd, state) do
    target = cmd["target"]
    target_type = target["target"]

    result =
      case target_type do
        "idempotent-producer" ->
          validate_idempotent_producer(target)

        "retry-options" ->
          validate_retry_options(target)

        _ ->
          error_result("validate", "NOT_SUPPORTED", "Unknown validation target: #{target_type}")
      end

    {result, state}
  end

  defp handle_command(%{"type" => type}, state) do
    result = error_result(type, "NOT_SUPPORTED", "Unknown command type: #{type}")
    {result, state}
  end

  # Read multiple chunks
  defp read_chunks(stream, opts, max_chunks, wait_for_up_to_date, live_mode) do
    do_read_chunks(stream, opts, max_chunks, wait_for_up_to_date, live_mode, [], opts[:offset], false, 200)
  end

  defp do_read_chunks(_stream, _opts, 0, _wait, _live, chunks, offset, up_to_date, status) do
    {:ok, Enum.reverse(chunks), offset, up_to_date, status}
  end

  defp do_read_chunks(stream, opts, remaining, wait_for_up_to_date, live_mode, chunks, current_offset, _up_to_date, _status) do
    read_opts = Keyword.put(opts, :offset, current_offset)

    # For SSE, halt when up_to_date to avoid waiting for timeout
    # If waitForUpToDate is true, halt immediately even with 0 events
    # Otherwise, only halt if we've received some data
    read_opts = if live_mode == :sse do
      read_opts
      |> Keyword.put(:halt_on_up_to_date, true)
      |> Keyword.put(:halt_on_up_to_date_immediate, wait_for_up_to_date)
    else
      read_opts
    end

    case Stream.read(stream, read_opts) do
      {:ok, chunk} ->
        new_chunk =
          if byte_size(chunk.data) > 0 do
            # Check if data is binary (not valid UTF-8 or contains replacement characters)
            # U+FFFD (0xEF 0xBF 0xBD) is inserted by text decoders for invalid bytes
            is_binary = not String.valid?(chunk.data) or
                        :binary.match(chunk.data, <<0xEF, 0xBF, 0xBD>>) != :nomatch

            if is_binary do
              [%{"data" => Base.encode64(chunk.data), "offset" => chunk.next_offset, "binary" => true}]
            else
              [%{"data" => chunk.data, "offset" => chunk.next_offset}]
            end
          else
            []
          end

        new_chunks = new_chunk ++ chunks
        chunk_status = Map.get(chunk, :status, 200)
        got_data = byte_size(chunk.data) > 0
        new_remaining = if got_data, do: remaining - 1, else: remaining

        cond do
          # If up to date and we're waiting for it, stop
          chunk.up_to_date and wait_for_up_to_date ->
            {:ok, Enum.reverse(new_chunks), chunk.next_offset, true, chunk_status}

          # If up to date and not in live mode, stop
          chunk.up_to_date and live_mode == false ->
            {:ok, Enum.reverse(new_chunks), chunk.next_offset, true, chunk_status}

          # SSE: when up_to_date, stop - SSE collects all events in one connection
          # Don't loop for more as that starts a new SSE connection and waits for timeout
          chunk.up_to_date and live_mode == :sse ->
            {:ok, Enum.reverse(new_chunks), chunk.next_offset, true, chunk_status}

          # Long-poll: if we got data and have remaining chunks, continue polling for more
          # This handles the case where data arrives in batches (e.g., A then B then C)
          chunk.up_to_date and live_mode == :long_poll and new_remaining > 0 and got_data ->
            do_read_chunks(
              stream,
              opts,
              new_remaining,
              wait_for_up_to_date,
              live_mode,
              new_chunks,
              chunk.next_offset,
              chunk.up_to_date,
              chunk_status
            )

          # If up to date (timeout in live mode with no new data or remaining = 0), stop
          chunk.up_to_date ->
            {:ok, Enum.reverse(new_chunks), chunk.next_offset, true, chunk_status}

          # Continue reading
          true ->
            do_read_chunks(
              stream,
              opts,
              new_remaining,
              wait_for_up_to_date,
              live_mode,
              new_chunks,
              chunk.next_offset,
              chunk.up_to_date,
              chunk_status
            )
        end

      {:error, :timeout} ->
        # Timeout in live mode means up-to-date with no new data
        {:ok, Enum.reverse(chunks), current_offset, true, 204}

      {:error, reason} ->
        # On first read error (no chunks yet), propagate the error
        if chunks == [] do
          {:error, reason}
        else
          # If we already have chunks, return what we have
          {:ok, Enum.reverse(chunks), current_offset, true, 200}
        end
    end
  end

  # Resolve dynamic headers
  defp resolve_dynamic_headers(state) do
    {resolved, new_dynamics} =
      Enum.reduce(state.dynamic_headers, {%{}, %{}}, fn {name, dv}, {resolved, dynamics} ->
        case dv.type do
          "counter" ->
            new_counter = dv.counter + 1
            new_dv = %{dv | counter: new_counter}
            {Map.put(resolved, name, Integer.to_string(new_counter)), Map.put(dynamics, name, new_dv)}

          "timestamp" ->
            ts = System.system_time(:millisecond)
            {Map.put(resolved, name, Integer.to_string(ts)), Map.put(dynamics, name, dv)}

          "token" ->
            {Map.put(resolved, name, dv.token_value || ""), Map.put(dynamics, name, dv)}

          _ ->
            {resolved, Map.put(dynamics, name, dv)}
        end
      end)

    {resolved, %{state | dynamic_headers: new_dynamics}}
  end

  # Resolve dynamic params
  defp resolve_dynamic_params(state) do
    {resolved, new_dynamics} =
      Enum.reduce(state.dynamic_params, {%{}, %{}}, fn {name, dv}, {resolved, dynamics} ->
        case dv.type do
          "counter" ->
            new_counter = dv.counter + 1
            new_dv = %{dv | counter: new_counter}
            {Map.put(resolved, name, Integer.to_string(new_counter)), Map.put(dynamics, name, new_dv)}

          "timestamp" ->
            ts = System.system_time(:millisecond)
            {Map.put(resolved, name, Integer.to_string(ts)), Map.put(dynamics, name, dv)}

          _ ->
            {resolved, Map.put(dynamics, name, dv)}
        end
      end)

    {resolved, %{state | dynamic_params: new_dynamics}}
  end

  # Run benchmark operation
  defp run_benchmark(%{"op" => "append", "path" => path, "size" => size}, state) do
    stream = Client.stream(state.client, path)

    stream =
      if ct = state.stream_content_types[path] do
        Stream.set_content_type(stream, ct)
      else
        stream
      end

    data = :crypto.strong_rand_bytes(size)

    start = System.monotonic_time(:nanosecond)
    Stream.append(stream, data)
    duration = System.monotonic_time(:nanosecond) - start

    {duration, nil}
  end

  defp run_benchmark(%{"op" => "read", "path" => path} = op, state) do
    stream = Client.stream(state.client, path)
    offset = op["offset"] || "-1"

    start = System.monotonic_time(:nanosecond)
    Stream.read(stream, offset: offset)
    duration = System.monotonic_time(:nanosecond) - start

    {duration, nil}
  end

  defp run_benchmark(%{"op" => "create", "path" => path} = op, state) do
    content_type = op["contentType"] || "application/octet-stream"

    stream =
      state.client
      |> Client.stream(path)
      |> Stream.set_content_type(content_type)

    start = System.monotonic_time(:nanosecond)
    Stream.create(stream, content_type: content_type)
    duration = System.monotonic_time(:nanosecond) - start

    {duration, nil}
  end

  defp run_benchmark(%{"op" => "roundtrip", "path" => path, "size" => size} = op, state) do
    content_type = op["contentType"] || state.stream_content_types[path] || "application/octet-stream"
    live_mode = parse_live_mode(op["live"])

    stream =
      state.client
      |> Client.stream(path)
      |> Stream.set_content_type(content_type)

    data = :crypto.strong_rand_bytes(size)

    start = System.monotonic_time(:nanosecond)

    case Stream.append(stream, data) do
      {:ok, %{next_offset: offset}} ->
        # Calculate previous offset
        {offset_int, ""} = Integer.parse(offset)
        prev_offset = Integer.to_string(offset_int - size)
        Stream.read(stream, offset: prev_offset, live: live_mode)

      _ ->
        :ok
    end

    duration = System.monotonic_time(:nanosecond) - start

    {duration, nil}
  end

  defp run_benchmark(%{"op" => "throughput_append", "path" => path, "count" => count, "size" => size}, state) do
    content_type = state.stream_content_types[path] || "application/octet-stream"

    stream =
      state.client
      |> Client.stream(path)
      |> Stream.set_content_type(content_type)

    data = :crypto.strong_rand_bytes(size)

    # Use Writer for fire-and-forget batched writes
    {:ok, writer} = Writer.start_link(
      stream: stream,
      producer_id: "benchmark-#{:erlang.unique_integer([:positive])}",
      epoch: 0,
      max_batch_size: 100,
      linger_ms: 1,
      max_in_flight: 10
    )

    start = System.monotonic_time(:nanosecond)

    # Fire-and-forget all writes
    Enum.each(1..count, fn _ ->
      Writer.append(writer, data)
    end)

    # Wait for all writes to complete (use longer timeout for large counts)
    Writer.flush(writer, 120_000)
    Writer.close(writer, 120_000)

    duration = System.monotonic_time(:nanosecond) - start
    duration_sec = duration / 1_000_000_000

    metrics = %{
      "bytesTransferred" => count * size,
      "messagesProcessed" => count,
      "opsPerSecond" => count / duration_sec,
      "bytesPerSecond" => (count * size) / duration_sec
    }

    {duration, metrics}
  end

  defp run_benchmark(%{"op" => "throughput_read", "path" => path}, state) do
    stream = Client.stream(state.client, path)

    start = System.monotonic_time(:nanosecond)

    case Stream.read_all(stream, offset: "-1", max_chunks: 1000) do
      {:ok, chunks} ->
        duration = System.monotonic_time(:nanosecond) - start
        duration_sec = duration / 1_000_000_000

        total_bytes = Enum.reduce(chunks, 0, fn c, acc -> acc + byte_size(c.data) end)
        count = length(chunks)

        metrics = %{
          "bytesTransferred" => total_bytes,
          "messagesProcessed" => count,
          "bytesPerSecond" => total_bytes / duration_sec
        }

        {duration, metrics}

      {:error, _} ->
        {0, nil}
    end
  end

  defp run_benchmark(_op, _state) do
    {0, nil}
  end

  # Helper functions (grouped here to avoid warnings about non-grouped clauses)

  defp do_idempotent_append(stream, data, producer_id, epoch, seq, auto_claim, state) do
    opts = [
      producer_id: producer_id,
      epoch: epoch,
      producer_seq: seq
    ]

    case Stream.append(stream, data, opts) do
      {:ok, _result} ->
        result = %{
          "type" => "idempotent-append",
          "success" => true,
          "status" => 200
        }
        {result, state}

      {:error, {:stale_epoch, server_epoch}} when auto_claim ->
        # Auto-claim: retry with server_epoch + 1
        new_epoch = parse_epoch(server_epoch) + 1
        do_idempotent_append(stream, data, producer_id, new_epoch, 0, false, state)

      {:error, reason} ->
        {map_error("idempotent-append", reason), state}
    end
  end

  defp parse_epoch(nil), do: 0
  defp parse_epoch(epoch) when is_integer(epoch), do: epoch
  defp parse_epoch(epoch) when is_binary(epoch) do
    case Integer.parse(epoch) do
      {n, ""} -> n
      _ -> 0
    end
  end

  defp parse_live_mode("sse"), do: :sse
  defp parse_live_mode("long-poll"), do: :long_poll
  defp parse_live_mode(_), do: false

  defp do_idempotent_batch(stream, items, producer_id, epoch, auto_claim, is_json, state) do
    if is_json do
      # For JSON streams: batch all items as a single array
      # The server flattens one level, so [[a],[b]] becomes two entries [a] and [b]
      parsed_items =
        Enum.map(items, fn item ->
          data = if is_map(item), do: item["data"] || item, else: item
          case JSON.decode(data) do
            {:ok, parsed} -> parsed
            {:error, _} -> data
          end
        end)

      # Wrap all items in an array and send as a single batch
      batch_data = JSON.encode!(parsed_items)

      opts = [
        producer_id: producer_id,
        epoch: epoch,
        producer_seq: 0
      ]

      result =
        case Stream.append(stream, batch_data, opts) do
          {:ok, _} -> :ok
          {:error, {:stale_epoch, server_epoch}} when auto_claim ->
            {:auto_claim, server_epoch}
          {:error, reason} -> {:error, reason}
        end

      case result do
        :ok ->
          {%{
            "type" => "idempotent-append-batch",
            "success" => true,
            "status" => 200
          }, state}

        {:auto_claim, server_epoch} ->
          new_epoch = parse_epoch(server_epoch) + 1
          do_idempotent_batch(stream, items, producer_id, new_epoch, false, is_json, state)

        {:error, reason} ->
          {map_error("idempotent-append-batch", reason), state}
      end
    else
      # For non-JSON streams: send items sequentially with incrementing seq
      result =
        items
        |> Enum.with_index()
        |> Enum.reduce_while(:ok, fn {item, idx}, _acc ->
          data = if is_map(item), do: item["data"] || item, else: item

          opts = [
            producer_id: producer_id,
            epoch: epoch,
            producer_seq: idx
          ]

          case Stream.append(stream, data, opts) do
            {:ok, _} -> {:cont, :ok}
            {:error, {:stale_epoch, server_epoch}} when auto_claim ->
              {:halt, {:auto_claim, server_epoch}}
            {:error, reason} -> {:halt, {:error, reason}}
          end
        end)

      case result do
        :ok ->
          {%{
            "type" => "idempotent-append-batch",
            "success" => true,
            "status" => 200
          }, state}

        {:auto_claim, server_epoch} ->
          new_epoch = parse_epoch(server_epoch) + 1
          do_idempotent_batch(stream, items, producer_id, new_epoch, false, is_json, state)

        {:error, reason} ->
          {map_error("idempotent-append-batch", reason), state}
      end
    end
  end

  # Error mapping - with path for context
  defp map_error(cmd_type, :not_found, path) when is_binary(path) do
    error_result(cmd_type, "NOT_FOUND", "Stream not found: #{path}", 404)
  end

  # Error mapping - without path (fallback)
  defp map_error(cmd_type, :not_found) do
    error_result(cmd_type, "NOT_FOUND", "Stream not found", 404)
  end

  defp map_error(cmd_type, {:bad_request, msg}) do
    # Check if it's an invalid offset error by looking at the message
    msg_str = to_string(msg)
    if String.contains?(String.downcase(msg_str), "offset") do
      error_result(cmd_type, "INVALID_OFFSET", "Invalid offset: #{msg}", 400)
    else
      error_result(cmd_type, "BAD_REQUEST", "Bad request: #{msg}", 400)
    end
  end

  defp map_error(cmd_type, {:conflict, msg}) do
    # Check if it's a sequence conflict by looking at the message
    msg_str = to_string(msg)
    if String.contains?(String.downcase(msg_str), "sequence") do
      error_result(cmd_type, "SEQUENCE_CONFLICT", "Sequence conflict: #{msg}", 409)
    else
      error_result(cmd_type, "CONFLICT", "Conflict: #{msg}", 409)
    end
  end

  defp map_error(cmd_type, {:stale_epoch, epoch}) do
    error_result(cmd_type, "CONFLICT", "Stale epoch. Current: #{epoch}", 403)
  end

  defp map_error(cmd_type, {:sequence_gap, expected, received}) do
    %{
      "type" => "error",
      "success" => false,
      "commandType" => cmd_type,
      "status" => 409,
      "errorCode" => "SEQUENCE_CONFLICT",
      "message" => "Sequence gap: expected #{expected}, received #{received}",
      "producerExpectedSeq" => parse_int(expected),
      "producerReceivedSeq" => parse_int(received)
    }
  end

  defp map_error(cmd_type, {:gone, earliest}) do
    error_result(cmd_type, "INVALID_OFFSET", "Offset gone. Earliest: #{earliest}", 410)
  end

  defp map_error(cmd_type, {:unexpected_status, status, body}) do
    error_result(cmd_type, "UNEXPECTED_STATUS", "Status #{status}: #{body}", status)
  end

  defp map_error(cmd_type, reason) do
    error_result(cmd_type, "INTERNAL_ERROR", inspect(reason))
  end

  defp error_result(cmd_type, code, message, status \\ nil) do
    result = %{
      "type" => "error",
      "success" => false,
      "commandType" => cmd_type,
      "errorCode" => code,
      "message" => message
    }

    if status, do: Map.put(result, "status", status), else: result
  end

  # Validation helpers
  defp validate_idempotent_producer(target) do
    epoch = target["epoch"] || 0
    max_batch_bytes = target["maxBatchBytes"] || 1_048_576

    cond do
      epoch < 0 ->
        error_result("validate", "INVALID_ARGUMENT", "epoch must be non-negative, got: #{epoch}")

      max_batch_bytes < 1 ->
        error_result("validate", "INVALID_ARGUMENT", "maxBatchBytes must be positive, got: #{max_batch_bytes}")

      true ->
        %{
          "type" => "validate",
          "success" => true
        }
    end
  end

  defp validate_retry_options(target) do
    max_retries = target["maxRetries"] || 3
    initial_delay_ms = target["initialDelayMs"] || 100
    max_delay_ms = target["maxDelayMs"] || 5000
    multiplier = target["multiplier"] || 2.0

    cond do
      max_retries < 0 ->
        error_result("validate", "INVALID_ARGUMENT", "maxRetries must be non-negative, got: #{max_retries}")

      initial_delay_ms < 1 ->
        error_result("validate", "INVALID_ARGUMENT", "initialDelayMs must be positive, got: #{initial_delay_ms}")

      max_delay_ms < 1 ->
        error_result("validate", "INVALID_ARGUMENT", "maxDelayMs must be positive, got: #{max_delay_ms}")

      multiplier < 1.0 ->
        error_result("validate", "INVALID_ARGUMENT", "multiplier must be >= 1.0, got: #{multiplier}")

      true ->
        %{
          "type" => "validate",
          "success" => true
        }
    end
  end

  defp maybe_add_opt(opts, _key, nil), do: opts
  defp maybe_add_opt(opts, key, value), do: Keyword.put(opts, key, value)

  defp maybe_add_headers_sent(result, headers) when map_size(headers) > 0 do
    Map.put(result, "headersSent", headers)
  end

  defp maybe_add_headers_sent(result, _), do: result

  defp maybe_add_params_sent(result, params) when map_size(params) > 0 do
    Map.put(result, "paramsSent", params)
  end

  defp maybe_add_params_sent(result, _), do: result

  defp maybe_add_metrics(result, nil), do: result
  defp maybe_add_metrics(result, metrics), do: Map.put(result, "metrics", metrics)

  defp parse_int(nil), do: nil

  defp parse_int(s) when is_binary(s) do
    case Integer.parse(s) do
      {n, ""} -> n
      _ -> nil
    end
  end

  defp parse_int(n) when is_integer(n), do: n
end
