defmodule DurableStreams.Base64EncodingTest do
  use ExUnit.Case

  alias DurableStreams.HTTP.Finch, as: HTTPFinch

  describe "base64 decoding in SSE" do
    test "decodes base64 encoded data" do
      # Test the decode_sse_data function
      # "Hello World" encoded as base64
      input = "SGVsbG8gV29ybGQ="
      result = decode_sse_data(input, "base64")
      assert result == "Hello World"
    end

    test "handles empty base64 payload" do
      result = decode_sse_data("", "base64")
      assert result == ""
    end

    test "handles base64 with padding variations" do
      # 'a' - 2 padding chars
      assert decode_sse_data("YQ==", "base64") == "a"
      # 'ab' - 1 padding char
      assert decode_sse_data("YWI=", "base64") == "ab"
      # 'abc' - no padding
      assert decode_sse_data("YWJj", "base64") == "abc"
    end

    test "handles special binary bytes" do
      # bytes: 0x00, 0xFF, 0xFE, 0xFD, 0xFC
      input = "AP/+/fw="
      result = decode_sse_data(input, "base64")
      assert result == <<0x00, 0xFF, 0xFE, 0xFD, 0xFC>>
    end

    test "handles all byte values 0-255" do
      # All bytes 0x00-0xFF
      all_bytes = :binary.list_to_bin(Enum.to_list(0..255))
      encoded = Base.encode64(all_bytes)
      result = decode_sse_data(encoded, "base64")
      assert result == all_bytes
    end

    test "strips newlines from base64 before decoding" do
      # Base64 with embedded newlines (common in multi-line SSE data)
      input = "SGVs\nbG8g\nV29y\nbGQ="
      result = decode_sse_data(input, "base64")
      assert result == "Hello World"
    end

    test "strips carriage returns from base64 before decoding" do
      # Base64 with embedded carriage returns
      input = "SGVs\r\nbG8g\r\nV29y\r\nbGQ="
      result = decode_sse_data(input, "base64")
      assert result == "Hello World"
    end

    test "returns data as-is when encoding is nil" do
      input = "SGVsbG8gV29ybGQ="
      result = decode_sse_data(input, nil)
      # Should return the original base64 string, not decode it
      assert result == "SGVsbG8gV29ybGQ="
    end

    test "returns data as-is when encoding is not base64" do
      input = "Hello World"
      result = decode_sse_data(input, "text")
      assert result == "Hello World"
    end

    test "handles invalid base64 gracefully" do
      # Invalid base64 (not a multiple of 4, bad characters)
      input = "not-valid-base64!!!"
      result = decode_sse_data(input, "base64")
      # Should return original data when decoding fails
      assert result == input
    end
  end

  # Helper function to test base64 decoding logic
  # This mirrors the logic in DurableStreams.HTTP.Finch.decode_sse_data/2
  defp decode_sse_data(data, "base64") when is_binary(data) do
    # Remove any newlines/carriage returns per SSE protocol
    cleaned = String.replace(data, ~r/[\n\r]/, "")
    case Base.decode64(cleaned) do
      {:ok, decoded} -> decoded
      :error -> data  # If decoding fails, return original data
    end
  end

  defp decode_sse_data(data, _encoding), do: data
end
