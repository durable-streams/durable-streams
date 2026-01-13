defmodule DurableStreams.Application do
  @moduledoc false
  use Application

  @impl true
  def start(_type, _args) do
    children =
      [
        # Task supervisor for Writer async operations (unlinked tasks)
        {Task.Supervisor, name: DurableStreams.TaskSupervisor}
      ]
      |> maybe_add_finch()

    opts = [strategy: :one_for_one, name: DurableStreams.Supervisor]
    Supervisor.start_link(children, opts)
  end

  # Add Finch connection pool if available (for SSE streaming)
  defp maybe_add_finch(children) do
    if DurableStreams.HTTP.Finch.available?() do
      finch_spec = {Finch, name: DurableStreams.HTTP.Finch.finch_name()}
      children ++ [finch_spec]
    else
      children
    end
  end
end
