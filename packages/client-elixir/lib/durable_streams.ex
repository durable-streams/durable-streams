defmodule DurableStreams do
  @moduledoc """
  Elixir client for Durable Streams - persistent, resumable event streams over HTTP.

  ## Quick Start

  Use `use DurableStreams` to import convenient aliases that don't shadow
  Elixir's built-in `Stream` module:

      defmodule MyApp.EventProcessor do
        use DurableStreams

        def run do
          client = Client.new("http://localhost:8080")
          stream = Client.stream(client, "/events")

          {:ok, stream} = DS.create(stream, content_type: "application/json")
          {:ok, _} = DS.append(stream, ~s({"event": "test"}))
          {:ok, chunk} = DS.read(stream)

          # Elixir's Stream module is still available!
          chunk.data |> Stream.unfold(&parse_next/1) |> Enum.take(10)
        end
      end

  ## Aliases Provided

  - `Client` → `DurableStreams.Client`
  - `DS` → `DurableStreams.Stream` (avoids shadowing `Stream`)
  - `Consumer` → `DurableStreams.Consumer`
  - `Writer` → `DurableStreams.Writer`

  ## Architecture

  - `DurableStreams.Client` - Main client with connection settings
  - `DurableStreams.Stream` - Stream handle for CRUD operations
  - `DurableStreams.Consumer` - Long-running consumer GenServer
  - `DurableStreams.Writer` - Batched producer with exactly-once semantics
  """

  @version "0.1.0"

  @doc """
  Import convenient aliases for DurableStreams modules.

  Aliases `DurableStreams.Stream` as `DS` to avoid shadowing Elixir's
  built-in `Stream` module for lazy enumerables.
  """
  defmacro __using__(_opts) do
    quote do
      alias DurableStreams.Client
      alias DurableStreams.Stream, as: DS
      alias DurableStreams.Consumer
      alias DurableStreams.Writer
    end
  end

  @doc """
  Returns the library version.
  """
  @spec version() :: String.t()
  def version, do: @version
end
