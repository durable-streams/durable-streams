//// Error types for the Durable Streams client.

import gleam/option.{type Option}

/// Error type for stream operations.
pub type StreamError {
  /// Stream not found (HTTP 404)
  StreamNotFound(url: String)

  /// Stream already exists with different configuration (HTTP 409)
  StreamExists(url: String)

  /// Sequence conflict - sequence number was not strictly increasing (HTTP 409)
  SeqConflict(url: String)

  /// Content type mismatch between request and stream (HTTP 409)
  ContentTypeMismatch(url: String)

  /// Offset is before the earliest retained position (HTTP 410)
  OffsetGone(url: String, offset: String)

  /// Rate limited (HTTP 429)
  RateLimited(url: String, retry_after: Option(Int))

  /// Payload too large (HTTP 413)
  PayloadTooLarge(url: String)

  /// Bad request - invalid parameters or malformed request (HTTP 400)
  BadRequest(url: String, message: String)

  /// HTTP error with status code
  HttpError(url: String, status: Int, body: String)

  /// Network or connection error
  NetworkError(url: String, message: String)

  /// JSON encoding/decoding error
  JsonError(message: String)

  /// Timeout error
  TimeoutError(url: String)

  /// Invalid operation (e.g., appending empty data)
  InvalidOperation(message: String)
}

/// Returns a human-readable error message.
pub fn to_string(error: StreamError) -> String {
  case error {
    StreamNotFound(url) -> "Stream not found: " <> url
    StreamExists(url) -> "Stream already exists with different config: " <> url
    SeqConflict(url) -> "Sequence conflict: " <> url
    ContentTypeMismatch(url) -> "Content type mismatch: " <> url
    OffsetGone(url, offset) ->
      "Offset " <> offset <> " is before retention window: " <> url
    RateLimited(url, _) -> "Rate limited: " <> url
    PayloadTooLarge(url) -> "Payload too large: " <> url
    BadRequest(url, message) -> "Bad request to " <> url <> ": " <> message
    HttpError(url, status, body) ->
      "HTTP error "
      <> int_to_string(status)
      <> " for "
      <> url
      <> ": "
      <> body
    NetworkError(url, message) -> "Network error for " <> url <> ": " <> message
    JsonError(message) -> "JSON error: " <> message
    TimeoutError(url) -> "Timeout: " <> url
    InvalidOperation(message) -> "Invalid operation: " <> message
  }
}

import gleam/int

fn int_to_string(n: Int) -> String {
  int.to_string(n)
}

/// Returns True if the error indicates the stream was not found.
pub fn is_not_found(error: StreamError) -> Bool {
  case error {
    StreamNotFound(_) -> True
    _ -> False
  }
}

/// Returns True if the error indicates a conflict (409).
pub fn is_conflict(error: StreamError) -> Bool {
  case error {
    StreamExists(_) | SeqConflict(_) | ContentTypeMismatch(_) -> True
    _ -> False
  }
}

/// Returns True if the error indicates rate limiting.
pub fn is_rate_limited(error: StreamError) -> Bool {
  case error {
    RateLimited(_, _) -> True
    _ -> False
  }
}

/// Returns True if the error is retryable.
pub fn is_retryable(error: StreamError) -> Bool {
  case error {
    RateLimited(_, _) -> True
    NetworkError(_, _) -> True
    TimeoutError(_) -> True
    HttpError(_, status, _) if status >= 500 -> True
    _ -> False
  }
}

/// Creates an error from an HTTP status code.
pub fn from_status(
  url: String,
  status: Int,
  body: String,
) -> StreamError {
  case status {
    400 -> BadRequest(url, body)
    404 -> StreamNotFound(url)
    409 -> StreamExists(url)
    410 -> OffsetGone(url, "")
    413 -> PayloadTooLarge(url)
    429 -> RateLimited(url, option.None)
    _ -> HttpError(url, status, body)
  }
}
