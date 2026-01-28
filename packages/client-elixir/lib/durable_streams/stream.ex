defmodule DurableStreams.Stream do
  @moduledoc """
  A handle to a durable stream.

  Provides operations for creating, reading, appending, and deleting streams.

  ## Pipe-Friendly API

  Stream handles support a fluent builder pattern:

      client
      |> Client.stream("/events")
      |> DS.with_content_type("application/json")
      |> DS.with_headers(%{"x-tenant" => "acme"})
      |> DS.create!()

  ## Bang Functions

  All operations have `!` variants that raise on error:

      stream = DS.create!(stream, content_type: "application/json")
      chunk = DS.read!(stream)
      DS.append!(stream, data)

  ## JSON Convenience

  For JSON streams, use the `_json` variants:

      {:ok, items} = DS.read_json(stream)
      DS.append_json!(stream, %{event: "clicked", user_id: 123})
  """

  require Logger

  alias DurableStreams.{Client, HTTP, ReadChunk, AppendResult, HeadResult, CloseResult}

  defstruct [:client, :path, :content_type, :extra_headers]

  @type t :: %__MODULE__{
          client: Client.t(),
          path: String.t(),
          content_type: String.t() | nil,
          extra_headers: map()
        }

  @type offset :: String.t()

  @type head_result :: HeadResult.t()
  @type append_result :: AppendResult.t()
  @type read_chunk :: ReadChunk.t()

  @doc """
  Create a new stream handle.
  """
  @spec new(Client.t(), String.t()) :: t()
  def new(%Client{} = client, path) do
    %__MODULE__{
      client: client,
      path: path,
      content_type: nil,
      extra_headers: %{}
    }
  end

  @doc """
  Set the content type for this stream handle.
  """
  @spec set_content_type(t(), String.t()) :: t()
  def set_content_type(%__MODULE__{} = stream, content_type) do
    %{stream | content_type: content_type}
  end

  # ============================================================================
  # Pipe-Friendly Builders
  # ============================================================================

  @doc """
  Set the content type (pipe-friendly alias for `set_content_type/2`).

  ## Example

      stream
      |> DS.with_content_type("application/json")
      |> DS.create!()
  """
  @spec with_content_type(t(), String.t()) :: t()
  def with_content_type(%__MODULE__{} = stream, content_type) do
    %{stream | content_type: content_type}
  end

  @doc """
  Add extra headers to include with all requests on this stream handle.

  ## Example

      stream
      |> DS.with_headers(%{"x-tenant" => "acme", "x-request-id" => "abc123"})
      |> DS.create!()
  """
  @spec with_headers(t(), map()) :: t()
  def with_headers(%__MODULE__{} = stream, headers) when is_map(headers) do
    merged = Map.merge(stream.extra_headers, headers)
    %{stream | extra_headers: merged}
  end

  @doc """
  Get the full URL for this stream.
  """
  @spec url(t()) :: String.t()
  def url(%__MODULE__{client: client, path: path}) do
    client.base_url <> path
  end

  @doc """
  Create the stream on the server.

  ## Options

  - `:content_type` - Content type for the stream (default: "application/octet-stream")
  - `:ttl_seconds` - Time-to-live in seconds
  - `:expires_at` - Absolute expiry time (ISO 8601 string)
  - `:headers` - Additional headers
  - `:closed` - Create stream as immediately closed (default: false)
  - `:data` - Optional initial data to write (JSON strings are wrapped in an array)
  """
  @spec create(t(), keyword()) :: {:ok, t()} | {:error, term()}
  def create(%__MODULE__{} = stream, opts \\ []) do
    content_type = Keyword.get(opts, :content_type, stream.content_type || "application/octet-stream")
    ttl_seconds = Keyword.get(opts, :ttl_seconds)
    expires_at = Keyword.get(opts, :expires_at)
    closed = Keyword.get(opts, :closed, false)
    data = Keyword.get(opts, :data)
    extra_headers = Keyword.get(opts, :headers, %{})

    headers =
      [{"content-type", content_type}]
      |> maybe_add_header("stream-ttl", ttl_seconds && to_string(ttl_seconds))
      |> maybe_add_header("stream-expires-at", expires_at)
      |> maybe_add_header("stream-closed", if(closed, do: "true", else: nil))
      |> add_extra_headers(stream.client.default_headers)
      |> add_extra_headers(extra_headers)

    body =
      cond do
        is_nil(data) ->
          nil

        is_json_content_type?(content_type) ->
          "[#{data}]"

        true ->
          data
      end

    case HTTP.request(:put, url(stream), headers, body, timeout: stream.client.timeout) do
      {:ok, status, _resp_headers, _body} when status in [200, 201] ->
        {:ok, %{stream | content_type: content_type}}

      {:ok, status, _headers, body} ->
        {:error, {:unexpected_status, status, body}}

      {:error, reason} ->
        {:error, reason}
    end
  end

  @doc """
  Get stream metadata via HEAD request.
  """
  @spec head(t(), keyword()) :: {:ok, head_result()} | {:error, term()}
  def head(%__MODULE__{} = stream, opts \\ []) do
    extra_headers = Keyword.get(opts, :headers, %{})

    headers =
      []
      |> add_extra_headers(stream.client.default_headers)
      |> add_extra_headers(extra_headers)

    case HTTP.request(:head, url(stream), headers, nil, timeout: stream.client.timeout) do
      {:ok, 200, resp_headers, _body} ->
        next_offset = case HTTP.get_header(resp_headers, "stream-next-offset") do
          nil ->
            Logger.warning("HEAD response missing stream-next-offset header, defaulting to -1")
            "-1"
          offset -> offset
        end
        content_type = HTTP.get_header(resp_headers, "content-type")
        stream_closed = String.downcase(HTTP.get_header(resp_headers, "stream-closed") || "") == "true"

        {:ok, %HeadResult{next_offset: next_offset, content_type: normalize_content_type(content_type), stream_closed: stream_closed}}

      {:ok, 404, _headers, _body} ->
        {:error, :not_found}

      {:ok, status, _headers, body} ->
        {:error, {:unexpected_status, status, body}}

      {:error, reason} ->
        {:error, reason}
    end
  end

  @doc """
  Delete the stream.
  """
  @spec delete(t(), keyword()) :: :ok | {:error, term()}
  def delete(%__MODULE__{} = stream, opts \\ []) do
    extra_headers = Keyword.get(opts, :headers, %{})

    headers =
      []
      |> add_extra_headers(stream.client.default_headers)
      |> add_extra_headers(extra_headers)

    case HTTP.request(:delete, url(stream), headers, nil, timeout: stream.client.timeout) do
      {:ok, status, _resp_headers, _body} when status in [200, 204] ->
        :ok

      {:ok, 404, _headers, _body} ->
        {:error, :not_found}

      {:ok, status, _headers, body} ->
        {:error, {:unexpected_status, status, body}}

      {:error, reason} ->
        {:error, reason}
    end
  end

  @doc """
  Close the stream permanently (no more appends allowed).

  ## Options

  - `:data` - Optional final data to append before closing
  - `:content_type` - Content type for the final data
  - `:headers` - Additional headers
  """
  @spec close(t(), keyword()) :: {:ok, CloseResult.t()} | {:error, term()}
  def close(%__MODULE__{} = stream, opts \\ []) do
    data = Keyword.get(opts, :data)
    content_type = Keyword.get(opts, :content_type, stream.content_type || "application/octet-stream")
    extra_headers = Keyword.get(opts, :headers, %{})

    headers =
      [{"stream-closed", "true"}, {"content-type", content_type}]
      |> add_extra_headers(stream.client.default_headers)
      |> add_extra_headers(extra_headers)

    # For JSON streams, wrap data in array if provided
    body = if data && is_json_content_type?(content_type) do
      "[#{data}]"
    else
      data
    end

    case HTTP.request(:post, url(stream), headers, body, timeout: stream.client.timeout) do
      {:ok, status, resp_headers, _body} when status in [200, 204] ->
        final_offset = HTTP.get_header(resp_headers, "stream-next-offset") || "-1"
        {:ok, %CloseResult{final_offset: final_offset}}

      {:ok, 404, _headers, _body} ->
        {:error, :not_found}

      {:ok, 409, resp_headers, _body} ->
        stream_closed = String.downcase(HTTP.get_header(resp_headers, "stream-closed") || "") == "true"
        if stream_closed do
          final_offset = HTTP.get_header(resp_headers, "stream-next-offset") || "-1"
          {:ok, %CloseResult{final_offset: final_offset}}
        else
          {:error, {:conflict, "Stream conflict"}}
        end

      {:ok, status, _headers, body} ->
        {:error, {:unexpected_status, status, body}}

      {:error, reason} ->
        {:error, reason}
    end
  end

  @doc """
  Close the stream permanently, raising on error.

  See `close/2` for options.
  """
  @spec close!(t(), keyword()) :: CloseResult.t()
  def close!(%__MODULE__{} = stream, opts \\ []) do
    case close(stream, opts) do
      {:ok, result} -> result
      {:error, reason} -> raise "Failed to close stream: #{inspect(reason)}"
    end
  end

  # Helper to check if content type is JSON
  defp is_json_content_type?(nil), do: false
  defp is_json_content_type?(content_type) do
    normalized = content_type |> String.split(";") |> List.first() |> String.trim() |> String.downcase()
    normalized == "application/json" or String.ends_with?(normalized, "+json")
  end

  @doc """
  Append data to the stream.

  ## Options

  - `:headers` - Additional headers
  - `:seq` - Sequence number for stream-level ordering
  - `:producer_id` - Producer ID for idempotent writes
  - `:epoch` - Producer epoch for fencing
  - `:producer_seq` - Producer sequence number for deduplication
  """
  @spec append(t(), binary(), keyword()) :: {:ok, append_result()} | {:error, term()}
  def append(%__MODULE__{} = stream, data, opts \\ []) do
    extra_headers = Keyword.get(opts, :headers, %{})
    seq = Keyword.get(opts, :seq)
    producer_id = Keyword.get(opts, :producer_id)
    epoch = Keyword.get(opts, :epoch)
    producer_seq = Keyword.get(opts, :producer_seq)

    content_type = stream.content_type || "application/octet-stream"

    headers =
      [{"content-type", content_type}]
      |> maybe_add_header("stream-seq", seq && to_string(seq))
      |> maybe_add_header("producer-id", producer_id)
      |> maybe_add_header("producer-epoch", epoch && to_string(epoch))
      |> maybe_add_header("producer-seq", producer_seq && to_string(producer_seq))
      |> add_extra_headers(stream.client.default_headers)
      |> add_extra_headers(extra_headers)

    case HTTP.request(:post, url(stream), headers, data, timeout: stream.client.timeout) do
      {:ok, status, resp_headers, _body} when status in [200, 204] ->
        next_offset = case HTTP.get_header(resp_headers, "stream-next-offset") do
          nil ->
            Logger.warning("Append response missing stream-next-offset header, defaulting to -1")
            "-1"
          offset -> offset
        end
        duplicate = status == 204

        {:ok, %AppendResult{next_offset: next_offset, duplicate: duplicate}}

      {:ok, 404, _headers, _body} ->
        {:error, :not_found}

      {:ok, 403, resp_headers, _body} ->
        epoch = HTTP.get_header(resp_headers, "producer-epoch")
        {:error, {:stale_epoch, epoch}}

      {:ok, 409, resp_headers, body} ->
        stream_closed = String.downcase(HTTP.get_header(resp_headers, "stream-closed") || "") == "true"
        if stream_closed do
          {:error, :stream_closed}
        else
          expected_seq = HTTP.get_header(resp_headers, "producer-expected-seq")
          received_seq = HTTP.get_header(resp_headers, "producer-received-seq")

          if expected_seq do
            {:error, {:sequence_gap, expected_seq, received_seq}}
          else
            {:error, {:conflict, body}}
          end
        end

      {:ok, status, _headers, body} ->
        {:error, {:unexpected_status, status, body}}

      {:error, reason} ->
        {:error, reason}
    end
  end

  @doc """
  Read from the stream.

  ## Options

  - `:offset` - Starting offset (default: "-1" for beginning)
  - `:live` - Live mode: false, :long_poll, or :sse
  - `:timeout` - Timeout in milliseconds
  - `:headers` - Additional headers
  """
  @spec read(t(), keyword()) :: {:ok, read_chunk()} | {:error, term()}
  def read(%__MODULE__{} = stream, opts \\ []) do
    offset = Keyword.get(opts, :offset, "-1")
    live = Keyword.get(opts, :live, false)
    timeout = Keyword.get(opts, :timeout, stream.client.timeout)
    extra_headers = Keyword.get(opts, :headers, %{})
    halt_on_up_to_date = Keyword.get(opts, :halt_on_up_to_date, false)
    halt_on_up_to_date_immediate = Keyword.get(opts, :halt_on_up_to_date_immediate, false)

    # Use Finch for true SSE streaming when available
    is_sse = live == :sse or live == "sse"
    if is_sse and DurableStreams.HTTP.Finch.available?() do
      read_sse_finch(stream, offset, timeout, extra_headers, halt_on_up_to_date, halt_on_up_to_date_immediate)
    else
      read_httpc(stream, offset, live, timeout, extra_headers)
    end
  end

  # SSE streaming using Finch (true incremental delivery)
  defp read_sse_finch(stream, offset, timeout, extra_headers, halt_on_up_to_date, halt_on_up_to_date_immediate) do
    query_params = [{"offset", offset}, {"live", "sse"}]
    url_with_query = url(stream) <> "?" <> URI.encode_query(query_params)

    headers =
      [{"accept", "text/event-stream"}]
      |> add_extra_headers(stream.client.default_headers)
      |> add_extra_headers(extra_headers)

    # Accumulate events into a single response for API compatibility
    events_ref = make_ref()
    Process.put(events_ref, [])

    on_event = fn
      {:event, data, next_offset, up_to_date} ->
        events = Process.get(events_ref)
        Process.put(events_ref, [{data, next_offset, up_to_date} | events])
    end

    sse_opts = [
      timeout: timeout,
      halt_on_up_to_date: halt_on_up_to_date,
      halt_on_up_to_date_immediate: halt_on_up_to_date_immediate
    ]
    case DurableStreams.HTTP.Finch.stream_sse(url_with_query, headers, sse_opts, on_event) do
      {:ok, %{next_offset: final_offset, up_to_date: up_to_date}} ->
        events = Process.get(events_ref) |> Enum.reverse()
        Process.delete(events_ref)

        case events do
          [] ->
            # No events - need to get actual offset from server
            # (especially important when offset was "now")
            actual_offset =
              if final_offset do
                final_offset
              else
                case head(stream) do
                  {:ok, %{next_offset: off}} -> off
                  {:error, _} -> offset
                end
              end

            {:ok, %ReadChunk{
              data: "",
              next_offset: actual_offset,
              up_to_date: up_to_date || true,
              status: 204
            }}

          events ->
            # Combine all event data
            data = events |> Enum.map(fn {d, _, _} -> d end) |> Enum.join("")
            {_, last_offset, last_up_to_date} = List.last(events)
            {:ok, %ReadChunk{
              data: data,
              next_offset: last_offset || final_offset || offset,
              up_to_date: last_up_to_date || up_to_date,
              status: 200
            }}
        end

      {:error, reason} ->
        Process.delete(events_ref)
        {:error, reason}
    end
  end

  # Standard HTTP read using :httpc
  defp read_httpc(stream, offset, live, timeout, extra_headers) do
    # Build query parameters
    query_params =
      [{"offset", offset}]
      |> add_live_param(live)

    url_with_query = url(stream) <> "?" <> URI.encode_query(query_params)

    headers =
      []
      |> add_accept_header(live)
      |> add_extra_headers(stream.client.default_headers)
      |> add_extra_headers(extra_headers)

    # Use streaming mode for SSE to handle incremental responses
    streaming = live == :sse or live == "sse"

    case HTTP.request(:get, url_with_query, headers, nil, timeout: timeout, max_retries: 0, streaming: streaming) do
      {:ok, status, resp_headers, body} when status in [200, 204] ->
        content_type = HTTP.get_header(resp_headers, "content-type") || ""

        # Parse SSE response if content-type is text/event-stream
        # SSE has upToDate and nextOffset in the control event
        {data, sse_next_offset, sse_up_to_date} =
          if String.contains?(content_type, "text/event-stream") do
            parse_sse_response(body)
          else
            {body, nil, nil}
          end

        # Use SSE control event values if present, otherwise fall back to headers
        next_offset = sse_next_offset || HTTP.get_header(resp_headers, "stream-next-offset") || offset
        up_to_date = sse_up_to_date || HTTP.get_header(resp_headers, "stream-up-to-date") == "true" or status == 204

        {:ok, %ReadChunk{
          data: data,
          next_offset: next_offset,
          up_to_date: up_to_date,
          status: status
        }}

      {:ok, 400, _headers, body} ->
        {:error, {:bad_request, body}}

      {:ok, 404, _headers, _body} ->
        {:error, :not_found}

      {:ok, 410, resp_headers, _body} ->
        earliest = HTTP.get_header(resp_headers, "stream-earliest-offset")
        {:error, {:gone, earliest}}

      {:ok, status, _headers, body} ->
        {:error, {:unexpected_status, status, body}}

      {:error, :timeout} when streaming ->
        # For SSE, timeout without data means up-to-date
        # We need to get the actual tail offset from the server via HEAD
        # rather than returning the input offset (which could be "now")
        actual_offset =
          case head(stream) do
            {:ok, %{next_offset: off}} ->
              off

            {:error, head_reason} ->
              require Logger
              Logger.warning("SSE timeout: HEAD request failed with #{inspect(head_reason)}, using input offset")
              offset
          end
        {:ok, %ReadChunk{
          data: "",
          next_offset: actual_offset,
          up_to_date: true,
          status: 204
        }}

      {:error, {:timeout_partial, %{status: status, headers: resp_headers, partial_body: body}}} when streaming ->
        # For SSE, partial data on timeout is expected - we received some events
        content_type = HTTP.get_header(resp_headers, "content-type") || ""

        {data, sse_next_offset, sse_up_to_date} =
          if String.contains?(content_type, "text/event-stream") do
            parse_sse_response(body)
          else
            {body, nil, nil}
          end

        # Use SSE control event values if present, otherwise fall back to headers
        next_offset = sse_next_offset || HTTP.get_header(resp_headers, "stream-next-offset") || offset
        up_to_date = sse_up_to_date || HTTP.get_header(resp_headers, "stream-up-to-date") == "true" or status == 204

        {:ok, %ReadChunk{
          data: data,
          next_offset: next_offset,
          up_to_date: up_to_date,
          status: status
        }}

      {:error, reason} ->
        {:error, reason}
    end
  end

  @doc """
  Read all available data from the stream until up-to-date.
  Returns a list of chunks.
  """
  @spec read_all(t(), keyword()) :: {:ok, [read_chunk()]} | {:error, term()}
  def read_all(%__MODULE__{} = stream, opts \\ []) do
    offset = Keyword.get(opts, :offset, "-1")
    max_chunks = Keyword.get(opts, :max_chunks, 100)

    do_read_all(stream, offset, opts, [], max_chunks)
  end

  defp do_read_all(_stream, _offset, _opts, chunks, 0), do: {:ok, Enum.reverse(chunks)}

  defp do_read_all(stream, offset, opts, chunks, remaining) do
    case read(stream, Keyword.put(opts, :offset, offset)) do
      {:ok, chunk} ->
        new_chunks = if byte_size(chunk.data) > 0, do: [chunk | chunks], else: chunks

        if chunk.up_to_date do
          {:ok, Enum.reverse(new_chunks)}
        else
          do_read_all(stream, chunk.next_offset, opts, new_chunks, remaining - 1)
        end

      {:error, reason} ->
        {:error, reason}
    end
  end

  # ============================================================================
  # Bang Functions (raise on error)
  # ============================================================================

  @doc """
  Create the stream on the server, raising on error.

  See `create/2` for options.
  """
  @spec create!(t(), keyword()) :: t()
  def create!(%__MODULE__{} = stream, opts \\ []) do
    case create(stream, opts) do
      {:ok, stream} -> stream
      {:error, reason} -> raise "Failed to create stream: #{inspect(reason)}"
    end
  end

  @doc """
  Get stream metadata, raising on error.

  See `head/2` for options.
  """
  @spec head!(t(), keyword()) :: head_result()
  def head!(%__MODULE__{} = stream, opts \\ []) do
    case head(stream, opts) do
      {:ok, result} -> result
      {:error, reason} -> raise "Failed to get stream head: #{inspect(reason)}"
    end
  end

  @doc """
  Delete the stream, raising on error.

  See `delete/2` for options.
  """
  @spec delete!(t(), keyword()) :: :ok
  def delete!(%__MODULE__{} = stream, opts \\ []) do
    case delete(stream, opts) do
      :ok -> :ok
      {:error, reason} -> raise "Failed to delete stream: #{inspect(reason)}"
    end
  end

  @doc """
  Append data to the stream, raising on error.

  See `append/3` for options.
  """
  @spec append!(t(), binary(), keyword()) :: append_result()
  def append!(%__MODULE__{} = stream, data, opts \\ []) do
    case append(stream, data, opts) do
      {:ok, result} -> result
      {:error, reason} -> raise "Failed to append to stream: #{inspect(reason)}"
    end
  end

  @doc """
  Read from the stream, raising on error.

  See `read/2` for options.
  """
  @spec read!(t(), keyword()) :: read_chunk()
  def read!(%__MODULE__{} = stream, opts \\ []) do
    case read(stream, opts) do
      {:ok, chunk} -> chunk
      {:error, reason} -> raise "Failed to read from stream: #{inspect(reason)}"
    end
  end

  @doc """
  Read all chunks until up-to-date, raising on error.

  See `read_all/2` for options.
  """
  @spec read_all!(t(), keyword()) :: [read_chunk()]
  def read_all!(%__MODULE__{} = stream, opts \\ []) do
    case read_all(stream, opts) do
      {:ok, chunks} -> chunks
      {:error, reason} -> raise "Failed to read all from stream: #{inspect(reason)}"
    end
  end

  # ============================================================================
  # JSON Convenience Functions
  # ============================================================================

  @doc """
  Read from a JSON stream and parse the response.

  Returns `{:ok, {items, metadata}}` where items is the parsed JSON array
  and metadata contains `next_offset` and `up_to_date`.

  ## Options

  Same as `read/2`.

  ## Example

      {:ok, {items, meta}} = DS.read_json(stream)
      IO.inspect(items)  # [%{"id" => 1}, %{"id" => 2}]
      IO.inspect(meta.next_offset)  # "42"
  """
  @spec read_json(t(), keyword()) :: {:ok, {list(), map()}} | {:error, term()}
  def read_json(%__MODULE__{} = stream, opts \\ []) do
    case read(stream, opts) do
      {:ok, chunk} ->
        meta = %{next_offset: chunk.next_offset, up_to_date: chunk.up_to_date}

        if chunk.data == "" or byte_size(chunk.data) == 0 do
          {:ok, {[], meta}}
        else
          case DurableStreams.JSON.decode(chunk.data) do
            {:ok, items} when is_list(items) ->
              {:ok, {items, meta}}
            {:ok, item} ->
              {:ok, {[item], meta}}
            {:error, reason} ->
              {:error, {:json_decode_error, reason}}
          end
        end

      {:error, reason} ->
        {:error, reason}
    end
  end

  @doc """
  Read from a JSON stream, raising on error.

  Returns `{items, metadata}` tuple.

  ## Example

      {items, meta} = DS.read_json!(stream)
  """
  @spec read_json!(t(), keyword()) :: {list(), map()}
  def read_json!(%__MODULE__{} = stream, opts \\ []) do
    case read_json(stream, opts) do
      {:ok, {items, meta}} -> {items, meta}
      {:error, reason} -> raise "Failed to read JSON from stream: #{inspect(reason)}"
    end
  end

  @doc """
  Append JSON data to the stream.

  Encodes the term as JSON before appending. For arrays, each element
  becomes a separate item in the stream (JSON batching).

  ## Options

  Same as `append/3`.

  ## Example

      DS.append_json(stream, %{event: "clicked", user_id: 123})
      DS.append_json(stream, [%{id: 1}, %{id: 2}])  # Batch append
  """
  @spec append_json(t(), term(), keyword()) :: {:ok, append_result()} | {:error, term()}
  def append_json(%__MODULE__{} = stream, data, opts \\ []) do
    case DurableStreams.JSON.encode(data) do
      {:ok, json} ->
        # Ensure stream has JSON content type
        stream = if stream.content_type == nil do
          %{stream | content_type: "application/json"}
        else
          stream
        end
        append(stream, json, opts)

      {:error, reason} ->
        {:error, {:json_encode_error, reason}}
    end
  end

  @doc """
  Append JSON data to the stream, raising on error.

  ## Example

      DS.append_json!(stream, %{event: "clicked"})
  """
  @spec append_json!(t(), term(), keyword()) :: append_result()
  def append_json!(%__MODULE__{} = stream, data, opts \\ []) do
    case append_json(stream, data, opts) do
      {:ok, result} -> result
      {:error, reason} -> raise "Failed to append JSON to stream: #{inspect(reason)}"
    end
  end

  @doc """
  Returns an Elixir `Stream` that yields chunks from the durable stream.

  This provides a pipe-friendly, lazy enumerable for consuming stream data.
  Useful for scripting, testing, and functional composition with `Stream.*`/`Enum.*`.

  ## Options

  - `:offset` - Starting offset (default: `"-1"`)
  - `:live` - Live mode: `false`, `:long_poll`, or `:sse` (default: `:long_poll`)

  ## Example

      # Process chunks lazily
      stream
      |> DurableStreams.Stream.enumerate(live: :long_poll)
      |> Stream.map(fn chunk -> JSON.decode!(chunk.data) end)
      |> Stream.take(10)
      |> Enum.to_list()

      # Stop when caught up
      stream
      |> DurableStreams.Stream.enumerate()
      |> Stream.take_while(fn chunk -> not chunk.up_to_date end)
      |> Enum.each(&process_chunk/1)
  """
  @spec enumerate(t(), keyword()) :: Enumerable.t()
  def enumerate(%__MODULE__{} = stream, opts \\ []) do
    start_offset = Keyword.get(opts, :offset, "-1")
    live = Keyword.get(opts, :live, :long_poll)
    read_opts = Keyword.put(opts, :live, live)

    Stream.resource(
      fn -> start_offset end,
      fn offset ->
        case read(stream, Keyword.put(read_opts, :offset, offset)) do
          {:ok, chunk} ->
            if byte_size(chunk.data) > 0 do
              {[chunk], chunk.next_offset}
            else
              # Empty chunk (timeout with no data) - continue from same offset
              {[], offset}
            end

          {:error, :timeout} ->
            # Timeout is normal for long-poll - continue polling
            {[], offset}

          {:error, reason} ->
            # Other errors halt the stream
            raise "DurableStreams.Stream.enumerate error: #{inspect(reason)}"
        end
      end,
      fn _offset -> :ok end
    )
  end

  # Helper functions

  defp maybe_add_header(headers, _name, nil), do: headers
  defp maybe_add_header(headers, name, value), do: [{name, value} | headers]

  defp add_extra_headers(headers, extra) when is_map(extra) do
    Enum.reduce(extra, headers, fn {k, v}, acc ->
      [{to_string(k), to_string(v)} | acc]
    end)
  end

  defp add_extra_headers(headers, _), do: headers

  defp add_live_param(params, false), do: params
  defp add_live_param(params, :long_poll), do: [{"live", "long-poll"} | params]
  defp add_live_param(params, :sse), do: [{"live", "sse"} | params]
  defp add_live_param(params, "long-poll"), do: [{"live", "long-poll"} | params]
  defp add_live_param(params, "sse"), do: [{"live", "sse"} | params]

  defp add_accept_header(headers, :sse), do: [{"accept", "text/event-stream"} | headers]
  defp add_accept_header(headers, "sse"), do: [{"accept", "text/event-stream"} | headers]
  defp add_accept_header(headers, _), do: headers

  defp normalize_content_type(nil), do: nil

  defp normalize_content_type(content_type) do
    # Preserve the full content-type including charset parameters
    content_type
    |> String.trim()
    |> String.downcase()
  end

  # Parse Server-Sent Events response
  # Returns {data, next_offset, up_to_date}
  # Format:
  #   event: data
  #   data: <content>
  #
  #   event: control
  #   data: {"streamNextOffset":"...","upToDate":true}
  defp parse_sse_response(body) when is_binary(body) do
    events =
      body
      |> String.split(~r/\n\n+/)
      |> Enum.map(&parse_sse_event/1)
      |> Enum.filter(fn {_type, data} -> data != "" and data != nil end)

    # Extract data from data events
    data =
      events
      |> Enum.filter(fn {type, _data} -> type == :data end)
      |> Enum.map(fn {:data, data} -> data end)
      |> Enum.join("")

    # Extract control info from control event
    {next_offset, up_to_date} =
      events
      |> Enum.find(fn {type, _data} -> type == :control end)
      |> case do
        {:control, json} -> parse_control_event(json)
        nil -> {nil, nil}
      end

    {data, next_offset, up_to_date}
  end

  # Parse the control event JSON payload
  # Format: {"streamNextOffset":"...","upToDate":true/false}
  # Using simple pattern matching since format is predictable
  defp parse_control_event(json) do
    # Extract streamNextOffset
    next_offset =
      case Regex.run(~r/"streamNextOffset"\s*:\s*"([^"]*)"/, json) do
        [_, offset] -> offset
        _ -> nil
      end

    # Extract upToDate
    up_to_date =
      case Regex.run(~r/"upToDate"\s*:\s*(true|false)/, json) do
        [_, "true"] -> true
        [_, "false"] -> false
        _ -> nil
      end

    {next_offset, up_to_date}
  end

  # Parse a single SSE event block and return {type, data}
  defp parse_sse_event(event) do
    lines = String.split(event, "\n")

    # Extract event type (default to :data if not specified)
    # Use explicit matching to avoid atom table exhaustion from untrusted input
    event_type =
      Enum.find_value(lines, :data, fn line ->
        case String.split(line, ": ", parts: 2) do
          ["event", "data"] -> :data
          ["event", "control"] -> :control
          ["event", _unknown] -> :unknown
          _ -> nil
        end
      end)

    # Extract data lines
    data =
      lines
      |> Enum.reduce([], fn line, acc ->
        case String.split(line, ": ", parts: 2) do
          ["data", data] -> [data | acc]
          ["data:" <> rest] -> [String.trim_leading(rest) | acc]
          _ -> acc
        end
      end)
      |> Enum.reverse()
      |> Enum.join("\n")
      |> decode_sse_data(event_type)

    {event_type, data}
  end

  # Don't decode control events - they're JSON
  defp decode_sse_data("", _event_type), do: ""
  defp decode_sse_data(data, :control), do: data
  defp decode_sse_data(data, _event_type) do
    # SSE data events might be base64-encoded
    # Try to decode as base64, fall back to raw data
    case Base.decode64(data) do
      {:ok, decoded} -> decoded
      :error -> data
    end
  end
end
