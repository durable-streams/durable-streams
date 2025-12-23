//// Durable Streams Client for Gleam
////
//// A client library for the Durable Streams protocol, an HTTP-based protocol
//// for creating, appending to, and reading from durable, append-only streams.
////
//// ## Quick Start
////
//// ```gleam
//// import durable_streams/client
//// import durable_streams/stream
//// import durable_streams/types
//// import gleam/json
////
//// pub fn main() {
////   // Create a client
////   let c = client.new()
////
////   // Get a stream handle
////   let my_stream = client.get_stream(c, "https://example.com/v1/stream/my-stream")
////
////   // Create the stream as JSON type
////   let assert Ok(my_stream) = stream.create_json(my_stream)
////
////   // Append data
////   let assert Ok(result) = stream.append_json_default(my_stream, json.object([
////     #("event", json.string("test")),
////   ]))
////
////   // Read from the stream
////   let assert Ok(response) = stream.read_from_start(my_stream)
//// }
//// ```

// Re-export main types
pub type Client =
  durable_streams/client.Client

pub type Stream =
  durable_streams/stream.Stream

pub type Offset =
  durable_streams/types.Offset

pub type Metadata =
  durable_streams/types.Metadata

pub type AppendResult =
  durable_streams/types.AppendResult

pub type ReadResponse =
  durable_streams/types.ReadResponse

pub type Chunk =
  durable_streams/types.Chunk

pub type StreamError =
  durable_streams/error.StreamError

pub type LiveMode =
  durable_streams/types.LiveMode

pub type ContentType =
  durable_streams/types.ContentType

pub type ChunkIterator =
  durable_streams/iterator.ChunkIterator

pub type IteratorState =
  durable_streams/iterator.IteratorState

// Re-export offset constructors
pub const start_offset = durable_streams/types.start_offset

pub const offset = durable_streams/types.offset

// Re-export error checking functions
pub const is_not_found = durable_streams/error.is_not_found

pub const is_conflict = durable_streams/error.is_conflict

pub const is_rate_limited = durable_streams/error.is_rate_limited
