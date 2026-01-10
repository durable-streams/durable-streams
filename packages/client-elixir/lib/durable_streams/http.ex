defmodule DurableStreams.HTTP do
  @moduledoc """
  Low-level HTTP client using Erlang's :httpc.
  Provides connection pooling, retries, and streaming support.
  """

  @default_timeout 30_000
  @max_retries 3
  @retry_delays [100, 500, 1000]

  @type headers :: [{String.t(), String.t()}]
  @type response :: {:ok, status :: integer(), headers(), body :: binary()} | {:error, term()}

  @doc """
  Make an HTTP request with automatic retries for transient failures.
  """
  @spec request(
          method :: :get | :post | :put | :head | :delete,
          url :: String.t(),
          headers :: headers(),
          body :: binary() | nil,
          opts :: keyword()
        ) :: response()
  def request(method, url, headers \\ [], body \\ nil, opts \\ []) do
    timeout = Keyword.get(opts, :timeout, @default_timeout)
    max_retries = Keyword.get(opts, :max_retries, @max_retries)
    streaming = Keyword.get(opts, :streaming, false)

    # Ensure inets is started
    :inets.start()
    :ssl.start()

    if streaming do
      stream_request(method, url, headers, body, timeout)
    else
      do_request(method, url, headers, body, timeout, 0, max_retries)
    end
  end

  @doc """
  Make a streaming HTTP request using async mode.
  Body is received as messages and collected until timeout or stream end.
  """
  def stream_request(method, url, headers, body, timeout) do
    url_charlist = String.to_charlist(url)
    headers_charlist = Enum.map(headers, fn {k, v} ->
      {String.to_charlist(k), String.to_charlist(v)}
    end)

    http_opts = [
      timeout: timeout,
      connect_timeout: min(timeout, 10_000),
      ssl: [
        verify: :verify_none,
        versions: [:"tlsv1.2", :"tlsv1.3"]
      ]
    ]

    # Options for async streaming
    opts = [
      sync: false,
      stream: :self,
      body_format: :binary
    ]

    request =
      case {method, body} do
        {:get, _} -> {url_charlist, headers_charlist}
        {:head, _} -> {url_charlist, headers_charlist}
        {:delete, _} -> {url_charlist, headers_charlist}
        {_, nil} ->
          {content_type, other_headers} = extract_content_type(headers)
          other_headers_charlist = Enum.map(other_headers, fn {k, v} ->
            {String.to_charlist(k), String.to_charlist(v)}
          end)
          {url_charlist, other_headers_charlist, String.to_charlist(content_type), ~c""}
        {_, body} when is_binary(body) ->
          {content_type, other_headers} = extract_content_type(headers)
          other_headers_charlist = Enum.map(other_headers, fn {k, v} ->
            {String.to_charlist(k), String.to_charlist(v)}
          end)
          {url_charlist, other_headers_charlist, String.to_charlist(content_type), body}
      end

    case :httpc.request(method, request, http_opts, opts) do
      {:ok, request_id} ->
        collect_stream_response(request_id, timeout, nil, [], [])

      {:error, reason} ->
        {:error, reason}
    end
  end

  # Collect streaming response messages
  defp collect_stream_response(request_id, timeout, status, headers, body_parts) do
    # Calculate remaining time
    start_time = System.monotonic_time(:millisecond)

    receive do
      {:http, {^request_id, :stream_start, resp_headers}} ->
        # Stream started - parse headers to get status
        parsed_headers = parse_headers(resp_headers)
        # Continue collecting
        elapsed = System.monotonic_time(:millisecond) - start_time
        remaining = max(timeout - elapsed, 0)
        collect_stream_response(request_id, remaining, 200, parsed_headers, body_parts)

      {:http, {^request_id, :stream_start, resp_headers, _pid}} ->
        # Stream started with pid (for {self, once} mode)
        parsed_headers = parse_headers(resp_headers)
        elapsed = System.monotonic_time(:millisecond) - start_time
        remaining = max(timeout - elapsed, 0)
        collect_stream_response(request_id, remaining, 200, parsed_headers, body_parts)

      {:http, {^request_id, :stream, body_part}} ->
        # Received a chunk of body
        elapsed = System.monotonic_time(:millisecond) - start_time
        remaining = max(timeout - elapsed, 0)
        collect_stream_response(request_id, remaining, status, headers, [body_part | body_parts])

      {:http, {^request_id, :stream_end, _resp_headers}} ->
        # Stream completed - join body parts
        body = body_parts |> Enum.reverse() |> IO.iodata_to_binary()
        {:ok, status || 200, headers, body}

      {:http, {^request_id, {{_, resp_status, _}, resp_headers, resp_body}}} ->
        # Non-streaming response (error cases)
        parsed_headers = parse_headers(resp_headers)
        resp_body_bin = to_binary(resp_body)
        {:ok, resp_status, parsed_headers, resp_body_bin}

      {:http, {^request_id, {:error, reason}}} ->
        {:error, reason}

    after
      timeout ->
        # Timeout - cancel request and return what we have
        :httpc.cancel_request(request_id)
        if body_parts == [] do
          {:error, :timeout}
        else
          # Return partial data we collected
          body = body_parts |> Enum.reverse() |> IO.iodata_to_binary()
          {:ok, status || 200, headers, body}
        end
    end
  end

  defp extract_content_type(headers) do
    case Enum.split_with(headers, fn {k, _} -> String.downcase(k) == "content-type" end) do
      {[{_, ct} | _], rest} -> {ct, rest}
      {[], rest} -> {"application/octet-stream", rest}
    end
  end

  defp parse_headers(resp_headers) do
    Enum.map(resp_headers, fn {k, v} ->
      {List.to_string(k), List.to_string(v)}
    end)
  end

  defp to_binary(body) when is_list(body), do: :erlang.list_to_binary(body)
  defp to_binary(body) when is_binary(body), do: body

  defp do_request(method, url, headers, body, timeout, attempt, max_retries) do
    url_charlist = String.to_charlist(url)
    headers_charlist = Enum.map(headers, fn {k, v} ->
      {String.to_charlist(k), String.to_charlist(v)}
    end)

    http_opts = [
      timeout: timeout,
      connect_timeout: min(timeout, 10_000),
      ssl: [
        verify: :verify_none,
        versions: [:"tlsv1.2", :"tlsv1.3"]
      ]
    ]

    # Extract content-type from headers for POST/PUT requests
    {content_type_charlist, other_headers} =
      case Enum.split_with(headers, fn {k, _} -> String.downcase(k) == "content-type" end) do
        {[{_, ct} | _], rest} -> {String.to_charlist(ct), rest}
        {[], rest} -> {~c"application/octet-stream", rest}
      end

    other_headers_charlist = Enum.map(other_headers, fn {k, v} ->
      {String.to_charlist(k), String.to_charlist(v)}
    end)

    request =
      case {method, body} do
        {:get, _} ->
          {url_charlist, headers_charlist}

        {:head, _} ->
          {url_charlist, headers_charlist}

        {:delete, _} ->
          {url_charlist, headers_charlist}

        {_, nil} ->
          # PUT/POST with empty body - use extracted content-type
          {url_charlist, other_headers_charlist, content_type_charlist, ~c""}

        {_, body} when is_binary(body) ->
          {url_charlist, other_headers_charlist, content_type_charlist, body}
      end

    result =
      case method do
        :get -> :httpc.request(:get, request, http_opts, [body_format: :binary])
        :head -> :httpc.request(:head, request, http_opts, [body_format: :binary])
        :delete -> :httpc.request(:delete, request, http_opts, [body_format: :binary])
        :post -> :httpc.request(:post, request, http_opts, [body_format: :binary])
        :put -> :httpc.request(:put, request, http_opts, [body_format: :binary])
      end

    case result do
      {:ok, {{_, status, _}, resp_headers, resp_body}} ->
        parsed_headers =
          Enum.map(resp_headers, fn {k, v} ->
            {List.to_string(k), List.to_string(v)}
          end)

        resp_body_bin =
          case resp_body do
            body when is_list(body) -> :erlang.list_to_binary(body)
            body when is_binary(body) -> body
          end

        # Retry on 5xx or 429
        if status >= 500 or status == 429 do
          maybe_retry(method, url, headers, body, timeout, attempt, max_retries, status, parsed_headers, resp_body_bin)
        else
          {:ok, status, parsed_headers, resp_body_bin}
        end

      {:error, _reason} when attempt < max_retries ->
        delay = Enum.at(@retry_delays, attempt, 1000)
        Process.sleep(delay)
        do_request(method, url, headers, body, timeout, attempt + 1, max_retries)

      {:error, reason} ->
        {:error, reason}
    end
  end

  defp maybe_retry(method, url, headers, body, timeout, attempt, max_retries, status, resp_headers, resp_body) do
    if attempt < max_retries do
      # Check for Retry-After header on 429
      delay =
        case status do
          429 ->
            resp_headers
            |> Enum.find(fn {k, _} -> String.downcase(k) == "retry-after" end)
            |> case do
              {_, val} ->
                case Integer.parse(val) do
                  {secs, ""} -> secs * 1000
                  _ -> Enum.at(@retry_delays, attempt, 1000)
                end

              nil ->
                Enum.at(@retry_delays, attempt, 1000)
            end

          _ ->
            Enum.at(@retry_delays, attempt, 1000)
        end

      Process.sleep(delay)
      do_request(method, url, headers, body, timeout, attempt + 1, max_retries)
    else
      {:ok, status, resp_headers, resp_body}
    end
  end

  @doc """
  Get a header value by name (case-insensitive).
  """
  @spec get_header(headers(), String.t()) :: String.t() | nil
  def get_header(headers, name) do
    name_lower = String.downcase(name)

    Enum.find_value(headers, fn {k, v} ->
      if String.downcase(k) == name_lower, do: v
    end)
  end
end
