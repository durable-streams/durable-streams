//// Iterator for reading from a durable stream.
////
//// Provides a convenient way to iterate over chunks from a stream,
//// handling catch-up and live tailing automatically.

import durable_streams/error.{type StreamError}
import durable_streams/stream.{type Stream}
import durable_streams/types.{
  type Chunk, type LiveMode, type Offset, type ReadOptions, type ReadResponse,
}
import gleam/dynamic.{type DecodeError, type Dynamic}
import gleam/option.{type Option}

/// State of the stream iterator.
pub type IteratorState {
  /// More data may be available
  Running(offset: Offset, cursor: Option(String))
  /// Caught up with all available data (may have more in live mode)
  UpToDate(offset: Offset, cursor: Option(String))
  /// Iterator has been stopped
  Stopped
  /// Iterator encountered an error
  Failed(error: StreamError)
}

/// A stream iterator for reading chunks.
pub opaque type ChunkIterator {
  ChunkIterator(
    stream: Stream,
    live: LiveMode,
    headers: List(#(String, String)),
    timeout_ms: Option(Int),
    state: IteratorState,
  )
}

/// Creates a new chunk iterator.
pub fn new(
  stream: Stream,
  offset: Offset,
  live: LiveMode,
) -> ChunkIterator {
  ChunkIterator(
    stream: stream,
    live: live,
    headers: [],
    timeout_ms: option.None,
    state: Running(offset, option.None),
  )
}

/// Creates a new chunk iterator with options.
pub fn new_with_options(
  stream: Stream,
  offset: Offset,
  live: LiveMode,
  headers: List(#(String, String)),
  timeout_ms: Option(Int),
) -> ChunkIterator {
  ChunkIterator(
    stream: stream,
    live: live,
    headers: headers,
    timeout_ms: timeout_ms,
    state: Running(offset, option.None),
  )
}

/// Returns the current state of the iterator.
pub fn state(iter: ChunkIterator) -> IteratorState {
  iter.state
}

/// Returns the current offset.
pub fn current_offset(iter: ChunkIterator) -> Option(Offset) {
  case iter.state {
    Running(offset, _) -> option.Some(offset)
    UpToDate(offset, _) -> option.Some(offset)
    Stopped -> option.None
    Failed(_) -> option.None
  }
}

/// Returns True if the iterator is at the end (for non-live mode).
pub fn is_done(iter: ChunkIterator) -> Bool {
  case iter.live {
    types.LiveModeNone ->
      case iter.state {
        UpToDate(_, _) -> True
        Stopped -> True
        _ -> False
      }
    _ -> False
  }
}

/// Returns True if the iterator has encountered an error.
pub fn is_failed(iter: ChunkIterator) -> Bool {
  case iter.state {
    Failed(_) -> True
    _ -> False
  }
}

/// Fetches the next chunk from the stream.
/// Returns the chunk and an updated iterator.
pub fn next(
  iter: ChunkIterator,
) -> Result(#(Chunk, ChunkIterator), StreamError) {
  case iter.state {
    Stopped -> Error(error.InvalidOperation("Iterator has been stopped"))
    Failed(err) -> Error(err)
    Running(offset, cursor) -> fetch_next(iter, offset, cursor)
    UpToDate(offset, cursor) ->
      case iter.live {
        types.LiveModeNone ->
          // No live mode, we're done
          Error(error.InvalidOperation("No more data available"))
        _ ->
          // Live mode, keep trying
          fetch_next(iter, offset, cursor)
      }
  }
}

/// Stops the iterator.
pub fn stop(iter: ChunkIterator) -> ChunkIterator {
  ChunkIterator(..iter, state: Stopped)
}

/// Collects all chunks from the iterator (non-live mode only).
/// Stops when caught up or encounters an error.
pub fn collect_all(
  iter: ChunkIterator,
) -> Result(List(Chunk), StreamError) {
  collect_all_loop(iter, [])
}

fn collect_all_loop(
  iter: ChunkIterator,
  acc: List(Chunk),
) -> Result(List(Chunk), StreamError) {
  case is_done(iter) {
    True -> Ok(list.reverse(acc))
    False ->
      case next(iter) {
        Ok(#(chunk, new_iter)) -> collect_all_loop(new_iter, [chunk, ..acc])
        Error(err) ->
          case error.is_not_found(err) {
            True -> Ok(list.reverse(acc))
            False -> Error(err)
          }
      }
  }
}

import gleam/list

/// Processes each chunk with a callback function.
/// Continues until caught up (non-live) or callback returns False.
pub fn for_each(
  iter: ChunkIterator,
  callback: fn(Chunk) -> Bool,
) -> Result(ChunkIterator, StreamError) {
  case is_done(iter) {
    True -> Ok(iter)
    False ->
      case next(iter) {
        Ok(#(chunk, new_iter)) ->
          case callback(chunk) {
            True -> for_each(new_iter, callback)
            False -> Ok(stop(new_iter))
          }
        Error(err) ->
          case error.is_not_found(err) {
            True -> Ok(iter)
            False -> Error(err)
          }
      }
  }
}

/// Collects and parses all JSON items from the stream.
pub fn collect_json_items(
  iter: ChunkIterator,
  decoder: fn(Dynamic) -> Result(a, List(DecodeError)),
) -> Result(List(a), StreamError) {
  case collect_all(iter) {
    Ok(chunks) -> parse_all_json_chunks(chunks, decoder, [])
    Error(err) -> Error(err)
  }
}

fn parse_all_json_chunks(
  chunks: List(Chunk),
  decoder: fn(Dynamic) -> Result(a, List(DecodeError)),
  acc: List(a),
) -> Result(List(a), StreamError) {
  case chunks {
    [] -> Ok(list.reverse(acc))
    [chunk, ..rest] ->
      case stream.parse_json_items(chunk, decoder) {
        Ok(items) ->
          parse_all_json_chunks(rest, decoder, list.append(list.reverse(items), acc))
        Error(err) -> Error(err)
      }
  }
}

// Internal helpers

fn fetch_next(
  iter: ChunkIterator,
  offset: Offset,
  cursor: Option(String),
) -> Result(#(Chunk, ChunkIterator), StreamError) {
  let opts =
    types.ReadOptions(
      offset: offset,
      live: iter.live,
      cursor: cursor,
      timeout_ms: iter.timeout_ms,
      headers: iter.headers,
    )

  case stream.read(iter.stream, opts) {
    Ok(response) -> handle_response(iter, response)
    Error(err) -> {
      let new_iter = ChunkIterator(..iter, state: Failed(err))
      Error(err)
    }
  }
}

fn handle_response(
  iter: ChunkIterator,
  response: ReadResponse,
) -> Result(#(Chunk, ChunkIterator), StreamError) {
  case response {
    types.ReadData(chunk) -> {
      let new_state = case chunk.up_to_date {
        True -> UpToDate(chunk.next_offset, chunk.cursor)
        False -> Running(chunk.next_offset, chunk.cursor)
      }
      let new_iter = ChunkIterator(..iter, state: new_state)
      Ok(#(chunk, new_iter))
    }
    types.ReadEmpty(offset) -> {
      let new_iter = ChunkIterator(..iter, state: UpToDate(offset, option.None))
      Error(error.InvalidOperation("No data available"))
    }
    types.ReadTimeout(offset) -> {
      // For long-poll timeout, create an empty chunk and continue
      let chunk =
        types.Chunk(
          data: <<>>,
          next_offset: offset,
          up_to_date: True,
          cursor: option.None,
        )
      let new_iter = ChunkIterator(..iter, state: UpToDate(offset, option.None))
      Ok(#(chunk, new_iter))
    }
  }
}
