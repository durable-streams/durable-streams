//// Stream operations for the Durable Streams protocol.

import durable_streams/error.{type StreamError}
import durable_streams/types.{
  type AppendOptions, type AppendResult, type Chunk, type ContentType,
  type CreateOptions, type LiveMode, type Metadata, type Offset,
  type ReadOptions, type ReadResponse,
}
import gleam/bit_array
import gleam/dynamic.{type DecodeError, type Dynamic}
import gleam/http
import gleam/http/request.{type Request}
import gleam/http/response.{type Response}
import gleam/httpc
import gleam/int
import gleam/json
import gleam/list
import gleam/option.{type Option}
import gleam/result
import gleam/string
import gleam/uri

// Protocol header names
const header_content_type = "content-type"

const header_stream_offset = "stream-next-offset"

const header_stream_cursor = "stream-cursor"

const header_stream_up_to_date = "stream-up-to-date"

const header_stream_seq = "stream-seq"

const header_stream_ttl = "stream-ttl"

const header_stream_expires = "stream-expires-at"

const header_etag = "etag"

const header_if_match = "if-match"

/// A handle to a durable stream.
/// This is a lightweight, reusable object - not a persistent connection.
pub opaque type Stream {
  Stream(
    url: String,
    timeout_ms: Int,
    max_retries: Int,
    default_headers: List(#(String, String)),
    /// Cached content type from HEAD/Create operations
    content_type: Option(ContentType),
  )
}

/// Creates a new stream handle.
pub fn new(
  url: String,
  timeout_ms: Int,
  max_retries: Int,
  default_headers: List(#(String, String)),
) -> Stream {
  Stream(
    url: url,
    timeout_ms: timeout_ms,
    max_retries: max_retries,
    default_headers: default_headers,
    content_type: option.None,
  )
}

/// Returns the stream's URL.
pub fn url(stream: Stream) -> String {
  stream.url
}

/// Returns the cached content type, if available.
pub fn content_type(stream: Stream) -> Option(ContentType) {
  stream.content_type
}

/// Creates a new stream (idempotent).
/// Succeeds if the stream already exists with matching config.
/// Returns StreamExists error only if config differs (409 Conflict).
pub fn create(
  stream: Stream,
  opts: CreateOptions,
) -> Result(Stream, StreamError) {
  let content_type_str = types.content_type_to_string(opts.content_type)

  // Build headers
  let headers = [#(header_content_type, content_type_str), ..opts.headers]

  // Add TTL header if specified
  let headers = case opts.ttl_seconds {
    option.Some(ttl) -> [#(header_stream_ttl, int.to_string(ttl)), ..headers]
    option.None -> headers
  }

  // Add expires-at header if specified
  let headers = case opts.expires_at {
    option.Some(exp) -> [#(header_stream_expires, exp), ..headers]
    option.None -> headers
  }

  // Build request
  let req = build_request(stream, http.Put, headers)

  // Add body if initial data provided
  let req = case opts.initial_data {
    option.Some(data) -> request.set_body(req, data)
    option.None -> req
  }

  // Execute request
  case httpc.send_bits(req) {
    Ok(resp) ->
      case resp.status {
        201 | 200 | 204 ->
          Ok(Stream(
            ..stream,
            content_type: option.Some(opts.content_type),
          ))
        409 -> Error(error.StreamExists(stream.url))
        status -> Error(error.from_status(stream.url, status, response_body(resp)))
      }
    Error(err) -> Error(error.NetworkError(stream.url, httpc_error_to_string(err)))
  }
}

/// Creates a stream with default options.
pub fn create_default(stream: Stream) -> Result(Stream, StreamError) {
  create(stream, types.default_create_options())
}

/// Creates a JSON stream.
pub fn create_json(stream: Stream) -> Result(Stream, StreamError) {
  create(
    stream,
    CreateOptions(
      ..types.default_create_options(),
      content_type: types.ContentTypeJson,
    ),
  )
}

/// Appends data to the stream.
pub fn append(
  stream: Stream,
  data: BitArray,
  opts: AppendOptions,
) -> Result(AppendResult, StreamError) {
  // Validate data is not empty
  case bit_array.byte_size(data) {
    0 -> Error(error.InvalidOperation("Cannot append empty data"))
    _ -> do_append(stream, data, opts)
  }
}

fn do_append(
  stream: Stream,
  data: BitArray,
  opts: AppendOptions,
) -> Result(AppendResult, StreamError) {
  let content_type_str = case stream.content_type {
    option.Some(ct) -> types.content_type_to_string(ct)
    option.None -> "application/octet-stream"
  }

  // Build headers
  let headers = [#(header_content_type, content_type_str), ..opts.headers]

  // Add seq header if specified
  let headers = case opts.seq {
    option.Some(seq) -> [#(header_stream_seq, seq), ..headers]
    option.None -> headers
  }

  // Add if-match header if specified
  let headers = case opts.if_match {
    option.Some(etag) -> [#(header_if_match, etag), ..headers]
    option.None -> headers
  }

  // Build and execute request
  let req =
    build_request(stream, http.Post, headers)
    |> request.set_body(data)

  case httpc.send_bits(req) {
    Ok(resp) ->
      case resp.status {
        200 | 204 -> {
          let next_offset = get_header(resp, header_stream_offset)
          let etag = get_header_optional(resp, header_etag)
          Ok(AppendResult(
            next_offset: types.offset(option.unwrap(next_offset, "")),
            etag: etag,
          ))
        }
        404 -> Error(error.StreamNotFound(stream.url))
        409 -> Error(error.SeqConflict(stream.url))
        status -> Error(error.from_status(stream.url, status, response_body(resp)))
      }
    Error(err) -> Error(error.NetworkError(stream.url, httpc_error_to_string(err)))
  }
}

/// Appends data with default options.
pub fn append_default(
  stream: Stream,
  data: BitArray,
) -> Result(AppendResult, StreamError) {
  append(stream, data, types.default_append_options())
}

/// Appends a JSON value to the stream.
/// The value is encoded to JSON before appending.
pub fn append_json(
  stream: Stream,
  value: json.Json,
  opts: AppendOptions,
) -> Result(AppendResult, StreamError) {
  let json_str = json.to_string(value)
  let data = bit_array.from_string(json_str)
  append(stream, data, opts)
}

/// Appends a JSON value with default options.
pub fn append_json_default(
  stream: Stream,
  value: json.Json,
) -> Result(AppendResult, StreamError) {
  append_json(stream, value, types.default_append_options())
}

/// Deletes the stream.
pub fn delete(stream: Stream) -> Result(Nil, StreamError) {
  let req = build_request(stream, http.Delete, [])

  case httpc.send_bits(req) {
    Ok(resp) ->
      case resp.status {
        200 | 204 -> Ok(Nil)
        404 -> Error(error.StreamNotFound(stream.url))
        status -> Error(error.from_status(stream.url, status, response_body(resp)))
      }
    Error(err) -> Error(error.NetworkError(stream.url, httpc_error_to_string(err)))
  }
}

/// Returns stream metadata without reading content.
pub fn head(stream: Stream) -> Result(Metadata, StreamError) {
  let req = build_request(stream, http.Head, [])

  case httpc.send_bits(req) {
    Ok(resp) ->
      case resp.status {
        200 -> {
          let content_type = get_header(resp, header_content_type)
          let next_offset = get_header(resp, header_stream_offset)
          let ttl = get_header_optional(resp, header_stream_ttl)
          let expires_at = get_header_optional(resp, header_stream_expires)
          let etag = get_header_optional(resp, header_etag)

          Ok(Metadata(
            content_type: types.content_type_from_string(
              option.unwrap(content_type, "application/octet-stream"),
            ),
            next_offset: types.offset(option.unwrap(next_offset, "-1")),
            ttl_seconds: option.then(ttl, fn(s) {
              case int.parse(s) {
                Ok(n) -> option.Some(n)
                Error(_) -> option.None
              }
            })
              |> option.flatten,
            expires_at: expires_at,
            etag: etag,
          ))
        }
        404 -> Error(error.StreamNotFound(stream.url))
        status -> Error(error.from_status(stream.url, status, response_body(resp)))
      }
    Error(err) -> Error(error.NetworkError(stream.url, httpc_error_to_string(err)))
  }
}

/// Reads data from the stream (catch-up mode).
/// Returns immediately with available data.
pub fn read(
  stream: Stream,
  opts: ReadOptions,
) -> Result(ReadResponse, StreamError) {
  // Build URL with query parameters
  let read_url = build_read_url(stream.url, opts)

  // Build request
  let req_result =
    request.to(read_url)
    |> result.map(fn(req) {
      req
      |> request.set_method(http.Get)
      |> add_headers(stream.default_headers)
      |> add_headers(opts.headers)
    })

  case req_result {
    Error(_) -> Error(error.InvalidOperation("Invalid URL: " <> stream.url))
    Ok(req) -> {
      case httpc.send_bits(req) {
        Ok(resp) -> handle_read_response(stream.url, resp, opts)
        Error(err) ->
          Error(error.NetworkError(stream.url, httpc_error_to_string(err)))
      }
    }
  }
}

/// Reads from the start of the stream.
pub fn read_from_start(stream: Stream) -> Result(ReadResponse, StreamError) {
  read(stream, types.default_read_options())
}

/// Reads from a specific offset.
pub fn read_from_offset(
  stream: Stream,
  offset: Offset,
) -> Result(ReadResponse, StreamError) {
  read(stream, types.read_from_offset(offset))
}

/// Reads with live tailing using long-poll mode.
pub fn read_live(
  stream: Stream,
  offset: Offset,
) -> Result(ReadResponse, StreamError) {
  read(stream, types.read_live(offset, types.LiveModeLongPoll))
}

/// Parses JSON items from a chunk.
/// Returns a list of decoded items or an error.
pub fn parse_json_items(
  chunk: Chunk,
  decoder: fn(Dynamic) -> Result(a, List(DecodeError)),
) -> Result(List(a), StreamError) {
  case bit_array.to_string(chunk.data) {
    Error(_) -> Error(error.JsonError("Invalid UTF-8 data"))
    Ok(json_str) ->
      case json.decode(json_str, dynamic.list(decoder)) {
        Ok(items) -> Ok(items)
        Error(err) -> Error(error.JsonError(json_decode_error_to_string(err)))
      }
  }
}

// Helper functions

fn build_request(
  stream: Stream,
  method: http.Method,
  headers: List(#(String, String)),
) -> Request(BitArray) {
  let req =
    request.new()
    |> request.set_method(method)

  // Parse URL and set host/path
  case uri.parse(stream.url) {
    Ok(parsed) -> {
      let host = option.unwrap(parsed.host, "localhost")
      let path = option.unwrap(parsed.path, "/") |> fn(p) {
        case p {
          "" -> "/"
          other -> other
        }
      }
      let scheme = case parsed.scheme {
        option.Some("https") -> http.Https
        _ -> http.Http
      }
      let port = parsed.port

      req
      |> request.set_host(host)
      |> request.set_path(path)
      |> request.set_scheme(scheme)
      |> fn(r) {
        case port {
          option.Some(p) -> request.set_port(r, p)
          option.None -> r
        }
      }
      |> add_headers(stream.default_headers)
      |> add_headers(headers)
    }
    Error(_) -> req
  }
}

fn add_headers(
  req: Request(BitArray),
  headers: List(#(String, String)),
) -> Request(BitArray) {
  list.fold(headers, req, fn(r, h) {
    request.set_header(r, h.0, h.1)
  })
}

fn get_header(resp: Response(BitArray), name: String) -> Option(String) {
  resp.headers
  |> list.find(fn(h) { string.lowercase(h.0) == name })
  |> result.map(fn(h) { h.1 })
  |> option.from_result
}

fn get_header_optional(resp: Response(BitArray), name: String) -> Option(String) {
  get_header(resp, name)
}

fn response_body(resp: Response(BitArray)) -> String {
  bit_array.to_string(resp.body)
  |> result.unwrap("")
}

fn build_read_url(base_url: String, opts: ReadOptions) -> String {
  let offset_str = types.offset_to_string(opts.offset)

  // Start with offset parameter
  let params = [#("offset", offset_str)]

  // Add live mode parameter
  let params = case opts.live {
    types.LiveModeLongPoll -> [#("live", "long-poll"), ..params]
    types.LiveModeSSE -> [#("live", "sse"), ..params]
    types.LiveModeNone -> params
  }

  // Add cursor parameter
  let params = case opts.cursor {
    option.Some(c) -> [#("cursor", c), ..params]
    option.None -> params
  }

  // Build query string
  let query =
    params
    |> list.map(fn(p) { p.0 <> "=" <> uri.percent_encode(p.1) })
    |> string.join("&")

  case query {
    "" -> base_url
    q -> base_url <> "?" <> q
  }
}

fn handle_read_response(
  url: String,
  resp: Response(BitArray),
  opts: ReadOptions,
) -> Result(ReadResponse, StreamError) {
  case resp.status {
    200 -> {
      let next_offset = get_header(resp, header_stream_offset)
      let up_to_date = case get_header(resp, header_stream_up_to_date) {
        option.Some("true") -> True
        _ -> False
      }
      let cursor = get_header_optional(resp, header_stream_cursor)

      let chunk =
        Chunk(
          data: resp.body,
          next_offset: types.offset(option.unwrap(next_offset, "")),
          up_to_date: up_to_date,
          cursor: cursor,
        )

      Ok(ReadData(chunk))
    }
    204 -> {
      // No new data (long-poll timeout or empty)
      let next_offset = get_header(resp, header_stream_offset)
      let offset = types.offset(option.unwrap(next_offset, types.offset_to_string(opts.offset)))

      case opts.live {
        types.LiveModeLongPoll -> Ok(ReadTimeout(offset))
        _ -> Ok(ReadEmpty(offset))
      }
    }
    404 -> Error(error.StreamNotFound(url))
    410 -> Error(error.OffsetGone(url, types.offset_to_string(opts.offset)))
    status -> Error(error.from_status(url, status, response_body(resp)))
  }
}

fn httpc_error_to_string(err: httpc.HttpError) -> String {
  case err {
    httpc.InvalidUtf8Response -> "Invalid UTF-8 response"
    httpc.FailedToConnect -> "Failed to connect"
    httpc.OtherError(msg) -> msg
  }
}

fn json_decode_error_to_string(err: json.DecodeError) -> String {
  case err {
    json.UnexpectedEndOfInput -> "Unexpected end of input"
    json.UnexpectedByte(b) -> "Unexpected byte: " <> b
    json.UnexpectedSequence(s) -> "Unexpected sequence: " <> s
    json.UnexpectedFormat(errs) ->
      "Unexpected format: "
      <> list.map(errs, fn(e) { e.expected <> " at " <> string.join(e.path, ".") })
      |> string.join(", ")
  }
}
