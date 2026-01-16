defmodule DurableStreams.JSON do
  @moduledoc false
  # Internal: JSON encoder/decoder wrapper.
  # Uses native JSON (Elixir 1.18+) when available, falls back to Jason.

  # Check at compile time which JSON implementation is available
  @native_json_available Code.ensure_loaded?(JSON) and function_exported?(JSON, :decode!, 1)

  if @native_json_available do
    @doc """
    Decode a JSON string into an Elixir term.
    """
    @spec decode(String.t()) :: {:ok, term()} | {:error, term()}
    def decode(string) when is_binary(string) do
      {:ok, JSON.decode!(string)}
    rescue
      e -> {:error, e}
    end

    @doc """
    Decode a JSON string, raising on error.
    """
    @spec decode!(String.t()) :: term()
    def decode!(string) when is_binary(string) do
      JSON.decode!(string)
    end

    @doc """
    Encode an Elixir term to JSON string.
    """
    @spec encode(term()) :: {:ok, String.t()} | {:error, term()}
    def encode(term) do
      {:ok, JSON.encode!(term)}
    rescue
      e -> {:error, e}
    end

    @doc """
    Encode an Elixir term to JSON string, raising on error.
    """
    @spec encode!(term()) :: String.t()
    def encode!(term) do
      JSON.encode!(term)
    end
  else
    # Check for Jason as fallback (Elixir < 1.18)
    if Code.ensure_loaded?(Jason) and function_exported?(Jason, :decode!, 1) do
      @doc """
      Decode a JSON string into an Elixir term.
      """
      @spec decode(String.t()) :: {:ok, term()} | {:error, term()}
      def decode(string) when is_binary(string) do
        Jason.decode(string)
      end

      @doc """
      Decode a JSON string, raising on error.
      """
      @spec decode!(String.t()) :: term()
      def decode!(string) when is_binary(string) do
        Jason.decode!(string)
      end

      @doc """
      Encode an Elixir term to JSON string.
      """
      @spec encode(term()) :: {:ok, String.t()} | {:error, term()}
      def encode(term) do
        Jason.encode(term)
      end

      @doc """
      Encode an Elixir term to JSON string, raising on error.
      """
      @spec encode!(term()) :: String.t()
      def encode!(term) do
        Jason.encode!(term)
      end
    else
      # Fallback: raise at compile time if no JSON library is available
      @compile {:no_warn_undefined, [JSON, Jason]}

      def decode(_string) do
        raise "No JSON library available. Please use Elixir 1.18+ or add {:jason, \"~> 1.4\"} to deps."
      end

      def decode!(_string) do
        raise "No JSON library available. Please use Elixir 1.18+ or add {:jason, \"~> 1.4\"} to deps."
      end

      def encode(_term) do
        raise "No JSON library available. Please use Elixir 1.18+ or add {:jason, \"~> 1.4\"} to deps."
      end

      def encode!(_term) do
        raise "No JSON library available. Please use Elixir 1.18+ or add {:jason, \"~> 1.4\"} to deps."
      end
    end
  end
end
