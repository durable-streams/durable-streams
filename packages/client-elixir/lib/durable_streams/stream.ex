defmodule DurableStreams.Stream do
  @moduledoc """
  A handle to a durable stream.

  Provides operations for creating, reading, appending, and deleting streams.
  """

  require Logger

  alias DurableStreams.{Client, HTTP}

  defstruct [:client, :path, :content_type, :extra_headers]

  @type t :: %__MODULE__{
          client: Client.t(),
          path: String.t(),
          content_type: String.t() | nil,
          extra_headers: map()
        }

  @type offset :: String.t()

  @type head_result :: %{
          next_offset: offset(),
          content_type: String.t() | nil
        }

  @type append_result :: %{
          next_offset: offset(),
          duplicate: boolean()
        }

  @type read_chunk :: %{
          data: binary(),
          next_offset: offset(),
          up_to_date: boolean(),
          status: integer()
        }

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
  """
  @spec create(t(), keyword()) :: {:ok, t()} | {:error, term()}
  def create(%__MODULE__{} = stream, opts \\ []) do
    content_type = Keyword.get(opts, :content_type, stream.content_type || "application/octet-stream")
    ttl_seconds = Keyword.get(opts, :ttl_seconds)
    expires_at = Keyword.get(opts, :expires_at)
    extra_headers = Keyword.get(opts, :headers, %{})

    headers =
      [{"content-type", content_type}]
      |> maybe_add_header("stream-ttl", ttl_seconds && to_string(ttl_seconds))
      |> maybe_add_header("stream-expires-at", expires_at)
      |> add_extra_headers(stream.client.default_headers)
      |> add_extra_headers(extra_headers)

    case HTTP.request(:put, url(stream), headers, nil, timeout: stream.client.timeout) do
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

        {:ok, %{next_offset: next_offset, content_type: normalize_content_type(content_type)}}

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
  Append data to the stream.

  ## Options

  - `:headers` - Additional headers
  - `:seq` - Sequence number for ordering
  - `:producer_id` - Producer ID for idempotent writes
  - `:producer_epoch` - Producer epoch
  - `:producer_seq` - Producer sequence number
  """
  @spec append(t(), binary(), keyword()) :: {:ok, append_result()} | {:error, term()}
  def append(%__MODULE__{} = stream, data, opts \\ []) do
    extra_headers = Keyword.get(opts, :headers, %{})
    seq = Keyword.get(opts, :seq)
    producer_id = Keyword.get(opts, :producer_id)
    producer_epoch = Keyword.get(opts, :producer_epoch)
    producer_seq = Keyword.get(opts, :producer_seq)

    content_type = stream.content_type || "application/octet-stream"

    headers =
      [{"content-type", content_type}]
      |> maybe_add_header("stream-seq", seq && to_string(seq))
      |> maybe_add_header("producer-id", producer_id)
      |> maybe_add_header("producer-epoch", producer_epoch && to_string(producer_epoch))
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

        {:ok, %{next_offset: next_offset, duplicate: duplicate}}

      {:ok, 404, _headers, _body} ->
        {:error, :not_found}

      {:ok, 403, resp_headers, _body} ->
        epoch = HTTP.get_header(resp_headers, "producer-epoch")
        {:error, {:stale_epoch, epoch}}

      {:ok, 409, resp_headers, body} ->
        expected_seq = HTTP.get_header(resp_headers, "producer-expected-seq")
        received_seq = HTTP.get_header(resp_headers, "producer-received-seq")

        if expected_seq do
          {:error, {:sequence_gap, expected_seq, received_seq}}
        else
          {:error, {:conflict, body}}
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

        {:ok, %{
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
        {:ok, %{
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

        {:ok, %{
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
