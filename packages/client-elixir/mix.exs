defmodule DurableStreams.MixProject do
  use Mix.Project

  @version "0.1.0"
  @source_url "https://github.com/durable-streams/durable-streams"

  def project do
    [
      app: :durable_streams,
      version: @version,
      elixir: "~> 1.14",
      start_permanent: Mix.env() == :prod,
      deps: deps(),
      escript: escript(),
      package: package(),
      docs: docs(),
      name: "DurableStreams",
      description: "Elixir client for Durable Streams - persistent, resumable event streams over HTTP",
      source_url: @source_url,
      aliases: aliases()
    ]
  end

  def application do
    [
      extra_applications: [:logger, :inets, :ssl, :crypto],
      mod: {DurableStreams.Application, []}
    ]
  end

  defp deps do
    [
      # Optional high-performance HTTP client (5-10x faster than :httpc)
      {:mint, "~> 1.6", optional: true},
      {:castore, "~> 1.0", optional: true}
      # Note: Without Mint, uses built-in :httpc (no external deps)
      # For Elixir < 1.18, add {:jason, "~> 1.4"} to use the Jason fallback
    ]
  end

  defp escript do
    [
      main_module: DurableStreams.ConformanceAdapter,
      name: "conformance-adapter"
    ]
  end

  defp package do
    [
      maintainers: ["Durable Streams Team"],
      licenses: ["MIT"],
      links: %{
        "GitHub" => @source_url
      }
    ]
  end

  defp docs do
    [
      main: "readme",
      extras: ["README.md"]
    ]
  end

  defp aliases do
    [
      build_adapter: ["escript.build"]
    ]
  end
end
