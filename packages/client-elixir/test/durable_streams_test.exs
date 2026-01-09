defmodule DurableStreamsTest do
  use ExUnit.Case
  doctest DurableStreams

  test "greets the world" do
    assert DurableStreams.hello() == :world
  end
end
