//// Core types for the Durable Streams client.

import gleam/option.{type Option}

/// An opaque offset token that identifies a position within a stream.
/// Offsets are lexicographically sortable and can be compared.
pub opaque type Offset {
  Offset(value: String)
}

/// Creates a new offset from a string value.
/// Use this to restore an offset that was previously persisted.
pub fn offset(value: String) -> Offset {
  Offset(value)
}

/// Returns the start offset (-1) which reads from the beginning.
pub fn start_offset() -> Offset {
  Offset("-1")
}

/// Returns the string representation of an offset.
pub fn offset_to_string(offset: Offset) -> String {
  offset.value
}

/// Returns True if this is the start offset.
pub fn is_start_offset(offset: Offset) -> Bool {
  offset.value == "-1"
}

/// Compares two offsets lexicographically.
/// Returns Lt if a < b, Eq if a == b, Gt if a > b.
pub fn compare_offsets(a: Offset, b: Offset) -> order.Order {
  string.compare(a.value, b.value)
}

import gleam/order
import gleam/string

/// Content type for streams.
pub type ContentType {
  /// Raw bytes with no message boundary preservation
  ContentTypeOctetStream
  /// JSON with message boundary preservation
  ContentTypeJson
  /// Newline-delimited JSON
  ContentTypeNdJson
  /// Plain text
  ContentTypeText
  /// Custom content type
  ContentTypeCustom(mime_type: String)
}

/// Converts a ContentType to its MIME type string.
pub fn content_type_to_string(ct: ContentType) -> String {
  case ct {
    ContentTypeOctetStream -> "application/octet-stream"
    ContentTypeJson -> "application/json"
    ContentTypeNdJson -> "application/x-ndjson"
    ContentTypeText -> "text/plain"
    ContentTypeCustom(mime) -> mime
  }
}

/// Parses a MIME type string to a ContentType.
pub fn content_type_from_string(s: String) -> ContentType {
  case s {
    "application/octet-stream" -> ContentTypeOctetStream
    "application/json" -> ContentTypeJson
    "application/x-ndjson" -> ContentTypeNdJson
    "text/plain" -> ContentTypeText
    other -> ContentTypeCustom(other)
  }
}

/// Live streaming mode for read operations.
pub type LiveMode {
  /// No live streaming - return immediately with available data (catch-up only)
  LiveModeNone
  /// Use HTTP long-polling for live updates
  LiveModeLongPoll
  /// Use Server-Sent Events for live updates (only for text/* and application/json)
  LiveModeSSE
}

/// Stream metadata returned by head operations.
pub type Metadata {
  Metadata(
    /// The stream's MIME type
    content_type: ContentType,
    /// The tail offset (next position after current end)
    next_offset: Offset,
    /// Remaining time-to-live in seconds, if set
    ttl_seconds: Option(Int),
    /// Absolute expiry time as RFC3339 string, if set
    expires_at: Option(String),
    /// ETag for conditional requests
    etag: Option(String),
  )
}

/// Result of an append operation.
pub type AppendResult {
  AppendResult(
    /// The tail offset after this append
    next_offset: Offset,
    /// ETag for conditional requests (if returned by server)
    etag: Option(String),
  )
}

/// A chunk of data from a read operation.
pub type Chunk {
  Chunk(
    /// The raw data bytes
    data: BitArray,
    /// The next offset to read from
    next_offset: Offset,
    /// True if caught up with all available data
    up_to_date: Bool,
    /// Cursor for CDN collapsing (if provided)
    cursor: Option(String),
  )
}

/// Response from a read operation.
pub type ReadResponse {
  /// Data is available
  ReadData(chunk: Chunk)
  /// No new data available (only for catch-up mode when at end)
  ReadEmpty(next_offset: Offset)
  /// Long-poll timeout with no new data
  ReadTimeout(next_offset: Offset)
}

/// Options for creating a stream.
pub type CreateOptions {
  CreateOptions(
    /// The stream's content type (default: application/octet-stream)
    content_type: ContentType,
    /// Time-to-live in seconds (mutually exclusive with expires_at)
    ttl_seconds: Option(Int),
    /// Absolute expiry time as RFC3339 timestamp (mutually exclusive with ttl)
    expires_at: Option(String),
    /// Initial data to write when creating the stream
    initial_data: Option(BitArray),
    /// Custom headers to include in the request
    headers: List(#(String, String)),
  )
}

/// Default create options.
pub fn default_create_options() -> CreateOptions {
  CreateOptions(
    content_type: ContentTypeOctetStream,
    ttl_seconds: option.None,
    expires_at: option.None,
    initial_data: option.None,
    headers: [],
  )
}

/// Options for appending to a stream.
pub type AppendOptions {
  AppendOptions(
    /// Sequence number for writer coordination (must be strictly increasing)
    seq: Option(String),
    /// ETag for optimistic concurrency control
    if_match: Option(String),
    /// Custom headers to include in the request
    headers: List(#(String, String)),
  )
}

/// Default append options.
pub fn default_append_options() -> AppendOptions {
  AppendOptions(seq: option.None, if_match: option.None, headers: [])
}

/// Options for reading from a stream.
pub type ReadOptions {
  ReadOptions(
    /// Starting offset (default: start_offset)
    offset: Offset,
    /// Live streaming mode (default: LiveModeNone)
    live: LiveMode,
    /// Cursor for CDN request collapsing
    cursor: Option(String),
    /// Timeout in milliseconds for long-poll mode
    timeout_ms: Option(Int),
    /// Custom headers to include in the request
    headers: List(#(String, String)),
  )
}

/// Default read options starting from the beginning.
pub fn default_read_options() -> ReadOptions {
  ReadOptions(
    offset: start_offset(),
    live: LiveModeNone,
    cursor: option.None,
    timeout_ms: option.None,
    headers: [],
  )
}

/// Read options starting from a specific offset.
pub fn read_from_offset(off: Offset) -> ReadOptions {
  ReadOptions(
    offset: off,
    live: LiveModeNone,
    cursor: option.None,
    timeout_ms: option.None,
    headers: [],
  )
}

/// Read options for live streaming.
pub fn read_live(off: Offset, mode: LiveMode) -> ReadOptions {
  ReadOptions(
    offset: off,
    live: mode,
    cursor: option.None,
    timeout_ms: option.None,
    headers: [],
  )
}
