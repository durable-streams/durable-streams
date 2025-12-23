//// HTTP client for Durable Streams.

import durable_streams/stream.{type Stream}
import gleam/option.{type Option}
import gleam/string

/// A Durable Streams client.
/// It is lightweight and reusable - not a persistent connection.
pub opaque type Client {
  Client(
    /// Base URL to prepend to stream paths (optional)
    base_url: Option(String),
    /// Default timeout in milliseconds
    timeout_ms: Int,
    /// Maximum retry attempts for transient errors
    max_retries: Int,
    /// Custom default headers for all requests
    default_headers: List(#(String, String)),
  )
}

/// Options for creating a new client.
pub type ClientOptions {
  ClientOptions(
    /// Base URL to prepend to stream paths (e.g., "https://api.example.com")
    base_url: Option(String),
    /// Default timeout in milliseconds (default: 30000)
    timeout_ms: Int,
    /// Maximum retry attempts for transient errors (default: 3)
    max_retries: Int,
    /// Custom default headers for all requests
    default_headers: List(#(String, String)),
  )
}

/// Default client options.
pub fn default_options() -> ClientOptions {
  ClientOptions(
    base_url: option.None,
    timeout_ms: 30_000,
    max_retries: 3,
    default_headers: [],
  )
}

/// Creates a new client with default options.
pub fn new() -> Client {
  new_with_options(default_options())
}

/// Creates a new client with the specified options.
pub fn new_with_options(opts: ClientOptions) -> Client {
  Client(
    base_url: opts.base_url,
    timeout_ms: opts.timeout_ms,
    max_retries: opts.max_retries,
    default_headers: opts.default_headers,
  )
}

/// Creates a new client with a base URL.
pub fn new_with_base_url(base_url: String) -> Client {
  Client(
    base_url: option.Some(string.trim_right(base_url, "/")),
    timeout_ms: 30_000,
    max_retries: 3,
    default_headers: [],
  )
}

/// Returns a handle to a stream at the given URL.
/// No network request is made until an operation is called.
///
/// The url can be:
/// - A full URL: "https://example.com/streams/my-stream"
/// - A path (if base_url was set): "/streams/my-stream"
pub fn get_stream(client: Client, url: String) -> Stream {
  let full_url = case client.base_url {
    option.Some(base) if !is_absolute_url(url) -> base <> url
    _ -> url
  }
  stream.new(
    full_url,
    client.timeout_ms,
    client.max_retries,
    client.default_headers,
  )
}

/// Returns the base URL if set.
pub fn base_url(client: Client) -> Option(String) {
  client.base_url
}

/// Returns the default timeout in milliseconds.
pub fn timeout_ms(client: Client) -> Int {
  client.timeout_ms
}

/// Returns the maximum retry attempts.
pub fn max_retries(client: Client) -> Int {
  client.max_retries
}

/// Checks if a URL is absolute (starts with http:// or https://).
fn is_absolute_url(url: String) -> Bool {
  string.starts_with(url, "http://") || string.starts_with(url, "https://")
}
