defmodule DurableStreams.ReadChunk do
  @moduledoc """
  Result of reading from a stream.

  ## Fields

  - `data` - Binary data read from the stream
  - `next_offset` - Offset to use for the next read
  - `up_to_date` - True when caught up with the stream tail
  - `status` - HTTP status code (200 for data, 204 for empty)
  """

  defstruct [:data, :next_offset, :up_to_date, :status]

  @type t :: %__MODULE__{
          data: binary(),
          next_offset: String.t(),
          up_to_date: boolean(),
          status: integer()
        }
end

defmodule DurableStreams.AppendResult do
  @moduledoc """
  Result of appending to a stream.

  ## Fields

  - `next_offset` - Offset after the appended data
  - `duplicate` - True if this was a duplicate write (idempotent producer)
  """

  defstruct [:next_offset, :duplicate]

  @type t :: %__MODULE__{
          next_offset: String.t(),
          duplicate: boolean()
        }
end

defmodule DurableStreams.HeadResult do
  @moduledoc """
  Result of getting stream metadata.

  ## Fields

  - `next_offset` - Current tail offset of the stream
  - `content_type` - Content type of the stream
  - `stream_closed` - Whether the stream has been closed (no more appends allowed)
  """

  defstruct [:next_offset, :content_type, stream_closed: false]

  @type t :: %__MODULE__{
          next_offset: String.t(),
          content_type: String.t() | nil,
          stream_closed: boolean()
        }
end

defmodule DurableStreams.CloseResult do
  @moduledoc """
  Result of closing a stream.

  ## Fields

  - `final_offset` - The final offset after closing (position after any appended data)
  """

  defstruct [:final_offset]

  @type t :: %__MODULE__{
          final_offset: String.t()
        }
end
