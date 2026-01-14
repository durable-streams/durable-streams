defmodule DurableStreams.Client do
  @moduledoc """
  Main client for interacting with Durable Streams.

  ## Example

      client = DurableStreams.Client.new("http://localhost:8080")
      stream = DurableStreams.Client.stream(client, "/streams/my-stream")
  """

  alias DurableStreams.Stream

  defstruct [:base_url, :default_headers, :timeout]

  @type t :: %__MODULE__{
          base_url: String.t(),
          default_headers: map(),
          timeout: pos_integer()
        }

  @doc """
  Create a new client with the given base URL.

  ## Options

  - `:headers` - Default headers to include with all requests
  - `:timeout` - Default timeout in milliseconds (default: 30000)
  """
  @spec new(String.t(), keyword()) :: t()
  def new(base_url, opts \\ []) do
    %__MODULE__{
      base_url: String.trim_trailing(base_url, "/"),
      default_headers: Keyword.get(opts, :headers, %{}),
      timeout: Keyword.get(opts, :timeout, 30_000)
    }
  end

  @doc """
  Get a Stream handle for the given path.
  """
  @spec stream(t(), String.t()) :: Stream.t()
  def stream(%__MODULE__{} = client, path) do
    Stream.new(client, path)
  end
end
