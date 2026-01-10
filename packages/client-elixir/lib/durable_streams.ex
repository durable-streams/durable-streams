defmodule DurableStreams do
  @moduledoc """
  Elixir client for Durable Streams - persistent, resumable event streams over HTTP.

  ## Quick Start

      # Create a client
      client = DurableStreams.Client.new("http://localhost:8080")

      # Get a stream handle
      stream = DurableStreams.Client.stream(client, "/streams/my-stream")

      # Create the stream
      {:ok, stream} = DurableStreams.Stream.create(stream, content_type: "application/json")

      # Append data
      {:ok, result} = DurableStreams.Stream.append(stream, ~s({"event": "test"}))

      # Read data
      {:ok, chunk} = DurableStreams.Stream.read(stream)

  ## Architecture

  - `DurableStreams.Client` - Main client with connection settings
  - `DurableStreams.Stream` - Stream handle for CRUD operations
  - `DurableStreams.HTTP` - Low-level HTTP client
  """

  @version "0.1.0"

  @doc """
  Returns the library version.
  """
  @spec version() :: String.t()
  def version, do: @version
end
