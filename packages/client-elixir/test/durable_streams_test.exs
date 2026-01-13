defmodule DurableStreamsTest do
  use ExUnit.Case
  doctest DurableStreams

  test "returns version" do
    assert DurableStreams.version() == "0.1.0"
  end
end
