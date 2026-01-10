defmodule DurableStreams.JSON do
  @moduledoc """
  Simple JSON encoder/decoder for the conformance adapter.
  Uses pattern matching for parsing and IO lists for encoding.
  """

  @doc """
  Decode a JSON string into an Elixir term.
  """
  @spec decode(String.t()) :: {:ok, term()} | {:error, term()}
  def decode(string) when is_binary(string) do
    try do
      {value, rest} = parse_value(String.trim(string))
      if String.trim(rest) == "" do
        {:ok, value}
      else
        {:error, {:unexpected_trailing, rest}}
      end
    rescue
      e -> {:error, e}
    end
  end

  @doc """
  Decode a JSON string, raising on error.
  """
  @spec decode!(String.t()) :: term()
  def decode!(string) do
    case decode(string) do
      {:ok, value} -> value
      {:error, reason} -> raise "JSON decode error: #{inspect(reason)}"
    end
  end

  @doc """
  Encode an Elixir term to JSON string.
  """
  @spec encode(term()) :: {:ok, String.t()} | {:error, term()}
  def encode(term) do
    try do
      {:ok, IO.iodata_to_binary(encode_value(term))}
    rescue
      e -> {:error, e}
    end
  end

  @doc """
  Encode an Elixir term to JSON string, raising on error.
  """
  @spec encode!(term()) :: String.t()
  def encode!(term) do
    case encode(term) do
      {:ok, json} -> json
      {:error, reason} -> raise "JSON encode error: #{inspect(reason)}"
    end
  end

  # Parser

  defp parse_value(<<>>), do: raise("Unexpected end of input")

  defp parse_value(<<"null", rest::binary>>), do: {nil, rest}
  defp parse_value(<<"true", rest::binary>>), do: {true, rest}
  defp parse_value(<<"false", rest::binary>>), do: {false, rest}

  defp parse_value(<<"{", rest::binary>>), do: parse_object(String.trim_leading(rest), %{})
  defp parse_value(<<"[", rest::binary>>), do: parse_array(String.trim_leading(rest), [])
  defp parse_value(<<"\"", rest::binary>>), do: parse_string(rest, [])

  defp parse_value(<<c, _::binary>> = str) when c in ?0..?9 or c == ?-, do: parse_number(str)

  defp parse_value(str) do
    str = String.trim_leading(str)
    parse_value(str)
  end

  defp parse_object(<<"}", rest::binary>>, acc), do: {acc, rest}

  defp parse_object(str, acc) do
    str = skip_ws(str)
    {key, rest} = parse_string_start(str)
    rest = skip_ws(rest)
    <<":", rest::binary>> = rest
    rest = skip_ws(rest)
    {value, rest} = parse_value(rest)
    rest = skip_ws(rest)

    acc = Map.put(acc, key, value)

    case rest do
      <<"}", rest::binary>> -> {acc, rest}
      <<",", rest::binary>> -> parse_object(skip_ws(rest), acc)
      _ -> raise "Expected } or , in object"
    end
  end

  defp parse_array(<<"]", rest::binary>>, acc), do: {Enum.reverse(acc), rest}

  defp parse_array(str, acc) do
    str = skip_ws(str)
    {value, rest} = parse_value(str)
    rest = skip_ws(rest)
    acc = [value | acc]

    case rest do
      <<"]", rest::binary>> -> {Enum.reverse(acc), rest}
      <<",", rest::binary>> -> parse_array(skip_ws(rest), acc)
      _ -> raise "Expected ] or , in array"
    end
  end

  defp parse_string_start(<<"\"", rest::binary>>), do: parse_string(rest, [])
  defp parse_string_start(_), do: raise("Expected string")

  defp parse_string(<<"\"", rest::binary>>, acc) do
    {IO.iodata_to_binary(Enum.reverse(acc)), rest}
  end

  defp parse_string(<<"\\", c, rest::binary>>, acc) do
    char =
      case c do
        ?" -> ?"
        ?\\ -> ?\\
        ?/ -> ?/
        ?b -> ?\b
        ?f -> ?\f
        ?n -> ?\n
        ?r -> ?\r
        ?t -> ?\t
        ?u ->
          <<hex::binary-size(4), rest2::binary>> = rest
          {code, ""} = Integer.parse(hex, 16)
          # Return tuple with rest and char
          {:unicode, code, rest2}
        _ -> c
      end

    case char do
      {:unicode, code, rest2} ->
        parse_string(rest2, [<<code::utf8>> | acc])
      _ ->
        parse_string(rest, [<<char>> | acc])
    end
  end

  defp parse_string(<<c, rest::binary>>, acc) do
    parse_string(rest, [<<c>> | acc])
  end

  defp parse_number(str) do
    {num_str, rest} = take_number_chars(str, [])

    value =
      if String.contains?(num_str, ".") or String.contains?(num_str, "e") or String.contains?(num_str, "E") do
        String.to_float(num_str)
      else
        String.to_integer(num_str)
      end

    {value, rest}
  end

  defp take_number_chars(<<c, rest::binary>>, acc) when c in ?0..?9 or c in [?-, ?+, ?., ?e, ?E] do
    take_number_chars(rest, [<<c>> | acc])
  end

  defp take_number_chars(rest, acc) do
    {IO.iodata_to_binary(Enum.reverse(acc)), rest}
  end

  defp skip_ws(str), do: String.trim_leading(str)

  # Encoder

  defp encode_value(nil), do: "null"
  defp encode_value(true), do: "true"
  defp encode_value(false), do: "false"

  defp encode_value(n) when is_integer(n), do: Integer.to_string(n)

  defp encode_value(n) when is_float(n) do
    :erlang.float_to_binary(n, [:compact, {:decimals, 17}])
  end

  defp encode_value(s) when is_binary(s), do: encode_string(s)
  defp encode_value(s) when is_atom(s), do: encode_string(Atom.to_string(s))

  defp encode_value(list) when is_list(list) do
    elements = Enum.map(list, &encode_value/1)
    ["[", Enum.intersperse(elements, ","), "]"]
  end

  defp encode_value(map) when is_map(map) do
    pairs =
      map
      |> Enum.map(fn {k, v} ->
        key = if is_atom(k), do: Atom.to_string(k), else: k
        [encode_string(key), ":", encode_value(v)]
      end)

    ["{", Enum.intersperse(pairs, ","), "}"]
  end

  defp encode_string(s) when is_binary(s) do
    # Handle binary data byte by byte to properly escape control characters
    # and handle non-UTF8 data
    escaped = encode_string_bytes(s, [])
    ["\"", escaped, "\""]
  end

  defp encode_string_bytes(<<>>, acc), do: Enum.reverse(acc)

  defp encode_string_bytes(<<?\", rest::binary>>, acc) do
    encode_string_bytes(rest, ["\\\"" | acc])
  end

  defp encode_string_bytes(<<?\\, rest::binary>>, acc) do
    encode_string_bytes(rest, ["\\\\" | acc])
  end

  defp encode_string_bytes(<<?\n, rest::binary>>, acc) do
    encode_string_bytes(rest, ["\\n" | acc])
  end

  defp encode_string_bytes(<<?\r, rest::binary>>, acc) do
    encode_string_bytes(rest, ["\\r" | acc])
  end

  defp encode_string_bytes(<<?\t, rest::binary>>, acc) do
    encode_string_bytes(rest, ["\\t" | acc])
  end

  defp encode_string_bytes(<<?\b, rest::binary>>, acc) do
    encode_string_bytes(rest, ["\\b" | acc])
  end

  defp encode_string_bytes(<<?\f, rest::binary>>, acc) do
    encode_string_bytes(rest, ["\\f" | acc])
  end

  # Control characters (0x00-0x1F) must be escaped as \uXXXX
  defp encode_string_bytes(<<c, rest::binary>>, acc) when c < 0x20 do
    hex = c |> Integer.to_string(16) |> String.pad_leading(4, "0")
    encode_string_bytes(rest, ["\\u#{hex}" | acc])
  end

  # Valid printable ASCII
  defp encode_string_bytes(<<c, rest::binary>>, acc) when c >= 0x20 and c < 0x80 do
    encode_string_bytes(rest, [<<c>> | acc])
  end

  # UTF-8 multi-byte sequences - try to decode properly
  defp encode_string_bytes(<<c, rest::binary>>, acc) when c >= 0x80 do
    # Check if this starts a valid UTF-8 sequence
    case try_decode_utf8_char(<<c, rest::binary>>) do
      {:ok, char, remaining} ->
        encode_string_bytes(remaining, [char | acc])
      :error ->
        # Not valid UTF-8 - escape as \uXXXX
        hex = c |> Integer.to_string(16) |> String.pad_leading(4, "0")
        encode_string_bytes(rest, ["\\u#{hex}" | acc])
    end
  end

  # Try to decode a UTF-8 character at the start of the binary
  defp try_decode_utf8_char(binary) do
    case binary do
      <<c::utf8, rest::binary>> ->
        {:ok, <<c::utf8>>, rest}
      _ ->
        :error
    end
  end
end
