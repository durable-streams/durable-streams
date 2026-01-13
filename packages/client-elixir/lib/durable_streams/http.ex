defmodule DurableStreams.HTTP do
  @moduledoc """
  Low-level HTTP client using Erlang's built-in :httpc.

  Provides connection pooling via :httpc profiles, automatic retries for
  transient failures, and streaming support for SSE.
  """

  require Logger

  @default_timeout 30_000
  @max_retries 3
  @retry_delays [100, 500, 1000]
  @profile :durable_streams_http

  @type headers :: [{String.t(), String.t()}]
  @type response :: {:ok, status :: integer(), headers(), body :: binary()} | {:error, term()}

  @doc """
  Initialize the HTTP client with optimized connection pooling.
  Call this once at application startup.
  """
  def init do
    :inets.start()
    :ssl.start()

    # Create a dedicated httpc profile with connection pooling
    case :inets.start(:httpc, profile: @profile) do
      {:ok, _pid} -> :ok
      {:error, {:already_started, _pid}} -> :ok
      error -> error
    end

    # Configure the profile for high performance
    :httpc.set_options([
      # Keep connections alive
      keep_alive_timeout: 120_000,
      # Allow many connections per host
      max_sessions: 100,
      max_keep_alive_length: 50,
      # Enable pipelining
      pipeline_timeout: 30_000,
      max_pipeline_length: 10,
      # Cookies disabled for speed
      cookies: :disabled
    ], @profile)

    :ok
  end

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

    ensure_started()

    if streaming do
      stream_request(method, url, headers, body, timeout)
    else
      do_request(method, url, headers, body, timeout, 0, max_retries)
    end
  end

  defp ensure_started do
    # Use persistent_term for cross-process initialization tracking
    case :persistent_term.get(:durable_streams_http_init, false) do
      true -> :ok
      false ->
        init()
        :persistent_term.put(:durable_streams_http_init, true)
        :ok
    end
  end

  @doc """
  Make a streaming HTTP request using async mode.
  Body is received as messages and collected until timeout or stream end.
  """
  def stream_request(method, url, headers, body, timeout) do
    url_charlist = String.to_charlist(url)
    headers_charlist = headers_to_charlist(headers)
    http_opts = http_options(timeout)

    request =
      case {method, body} do
        {m, _} when m in [:get, :head, :delete] ->
          {url_charlist, headers_charlist}

        {_, body_data} ->
          {content_type, other_headers} = extract_content_type(headers)
          body_to_send = if body_data == nil, do: ~c"", else: body_data
          {url_charlist, headers_to_charlist(other_headers), String.to_charlist(content_type), body_to_send}
      end

    opts = [sync: false, stream: :self, body_format: :binary]

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
          # Return error with partial data - caller must handle truncation
          body = body_parts |> Enum.reverse() |> IO.iodata_to_binary()
          {:error, {:timeout_partial, %{status: status || 200, headers: headers, partial_body: body}}}
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

  defp headers_to_charlist(headers) do
    Enum.map(headers, fn {k, v} ->
      {String.to_charlist(k), String.to_charlist(v)}
    end)
  end

  defp http_options(timeout) do
    [
      timeout: timeout,
      connect_timeout: min(timeout, 10_000),
      ssl: ssl_options()
    ]
  end

  defp ssl_options do
    base_opts = [versions: [:"tlsv1.2", :"tlsv1.3"]]

    if Application.get_env(:durable_streams, :verify_ssl, false) do
      # Production: verify peer certificates
      cacerts = :public_key.cacerts_get()
      [{:verify, :verify_peer}, {:cacerts, cacerts} | base_opts]
    else
      # Development: skip verification (default for backwards compatibility)
      [{:verify, :verify_none} | base_opts]
    end
  end

  defp to_binary(body) when is_list(body), do: :erlang.list_to_binary(body)
  defp to_binary(body) when is_binary(body), do: body

  defp do_request(method, url, headers, body, timeout, attempt, max_retries) do
    url_charlist = String.to_charlist(url)
    headers_charlist = headers_to_charlist(headers)
    http_opts = http_options(timeout)

    {content_type, other_headers} = extract_content_type(headers)
    content_type_charlist = String.to_charlist(content_type)
    other_headers_charlist = headers_to_charlist(other_headers)

    request =
      case {method, body} do
        {m, _} when m in [:get, :head, :delete] ->
          {url_charlist, headers_charlist}

        {_, nil} ->
          {url_charlist, other_headers_charlist, content_type_charlist, ~c""}

        {_, body_data} when is_binary(body_data) ->
          {url_charlist, other_headers_charlist, content_type_charlist, body_data}
      end

    result = :httpc.request(method, request, http_opts, [body_format: :binary], @profile)

    case result do
      {:ok, {{_, status, _}, resp_headers, resp_body}} ->
        parsed_headers = parse_headers(resp_headers)
        resp_body_bin = to_binary(resp_body)

        if status >= 500 or status == 429 do
          maybe_retry(method, url, headers, body, timeout, attempt, max_retries, status, parsed_headers, resp_body_bin)
        else
          {:ok, status, parsed_headers, resp_body_bin}
        end

      {:error, reason} when attempt < max_retries ->
        delay = Enum.at(@retry_delays, attempt, 1000)
        Logger.warning("HTTP request failed (attempt #{attempt + 1}/#{max_retries}): #{inspect(reason)}, retrying in #{delay}ms")
        Process.sleep(delay)
        do_request(method, url, headers, body, timeout, attempt + 1, max_retries)

      {:error, reason} ->
        {:error, reason}
    end
  end

  defp maybe_retry(method, url, headers, body, timeout, attempt, max_retries, status, resp_headers, resp_body) do
    if attempt < max_retries do
      delay = calculate_retry_delay(status, resp_headers, attempt)
      Process.sleep(delay)
      do_request(method, url, headers, body, timeout, attempt + 1, max_retries)
    else
      {:ok, status, resp_headers, resp_body}
    end
  end

  defp calculate_retry_delay(429, headers, attempt) do
    case Enum.find(headers, fn {k, _} -> String.downcase(k) == "retry-after" end) do
      {_, val} ->
        case Integer.parse(val) do
          {secs, ""} -> secs * 1000
          _ -> Enum.at(@retry_delays, attempt, 1000)
        end
      nil ->
        Enum.at(@retry_delays, attempt, 1000)
    end
  end

  defp calculate_retry_delay(_status, _headers, attempt) do
    Enum.at(@retry_delays, attempt, 1000)
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

  @doc """
  Fire multiple async POST requests and collect all responses.
  Uses HTTP pipelining for maximum throughput.
  Returns list of results in order.
  """
  @spec post_batch(String.t(), headers(), [binary()], keyword()) :: [{:ok, integer(), headers(), binary()} | {:error, term()}]
  def post_batch(url, headers, bodies, opts \\ []) do
    timeout = Keyword.get(opts, :timeout, @default_timeout)
    ensure_started()

    url_charlist = String.to_charlist(url)
    {content_type, other_headers} = extract_content_type(headers)
    headers_charlist = headers_to_charlist(other_headers)
    content_type_charlist = String.to_charlist(content_type)
    http_opts = http_options(timeout)

    request_ids =
      Enum.map(bodies, fn body ->
        request = {url_charlist, headers_charlist, content_type_charlist, body}
        :httpc.request(:post, request, http_opts, [sync: false, body_format: :binary], @profile)
      end)

    Enum.map(request_ids, fn
      {:ok, request_id} -> collect_async_response(request_id, timeout)
      {:error, reason} -> {:error, reason}
    end)
  end

  defp collect_async_response(request_id, timeout) do
    receive do
      {:http, {^request_id, {{_, status, _}, resp_headers, resp_body}}} ->
        parsed_headers = parse_headers(resp_headers)
        resp_body_bin = to_binary(resp_body)
        {:ok, status, parsed_headers, resp_body_bin}

      {:http, {^request_id, {:error, reason}}} ->
        {:error, reason}
    after
      timeout ->
        :httpc.cancel_request(request_id)
        {:error, :timeout}
    end
  end
end
