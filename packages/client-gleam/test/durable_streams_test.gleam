import durable_streams/client
import durable_streams/error
import durable_streams/types
import gleeunit
import gleeunit/should

pub fn main() {
  gleeunit.main()
}

// Client tests

pub fn client_new_test() {
  let c = client.new()
  c
  |> client.timeout_ms
  |> should.equal(30_000)

  c
  |> client.max_retries
  |> should.equal(3)
}

pub fn client_with_base_url_test() {
  let c = client.new_with_base_url("https://example.com")
  c
  |> client.base_url
  |> should.be_some
  |> should.equal("https://example.com")
}

pub fn client_with_options_test() {
  let c =
    client.new_with_options(client.ClientOptions(
      base_url: option.Some("https://api.example.com"),
      timeout_ms: 60_000,
      max_retries: 5,
      default_headers: [#("Authorization", "Bearer token")],
    ))

  c
  |> client.timeout_ms
  |> should.equal(60_000)

  c
  |> client.max_retries
  |> should.equal(5)
}

import gleam/option

// Offset tests

pub fn offset_start_test() {
  let start = types.start_offset()
  start
  |> types.is_start_offset
  |> should.be_true
}

pub fn offset_from_string_test() {
  let off = types.offset("abc123")
  off
  |> types.offset_to_string
  |> should.equal("abc123")
}

pub fn offset_compare_test() {
  let a = types.offset("abc")
  let b = types.offset("def")

  types.compare_offsets(a, b)
  |> should.equal(order.Lt)

  types.compare_offsets(b, a)
  |> should.equal(order.Gt)

  types.compare_offsets(a, a)
  |> should.equal(order.Eq)
}

import gleam/order

// Content type tests

pub fn content_type_to_string_test() {
  types.content_type_to_string(types.ContentTypeJson)
  |> should.equal("application/json")

  types.content_type_to_string(types.ContentTypeOctetStream)
  |> should.equal("application/octet-stream")

  types.content_type_to_string(types.ContentTypeCustom("text/html"))
  |> should.equal("text/html")
}

pub fn content_type_from_string_test() {
  types.content_type_from_string("application/json")
  |> should.equal(types.ContentTypeJson)

  types.content_type_from_string("text/plain")
  |> should.equal(types.ContentTypeText)

  types.content_type_from_string("custom/type")
  |> should.equal(types.ContentTypeCustom("custom/type"))
}

// Error tests

pub fn error_is_not_found_test() {
  error.StreamNotFound("http://example.com")
  |> error.is_not_found
  |> should.be_true

  error.RateLimited("http://example.com", option.None)
  |> error.is_not_found
  |> should.be_false
}

pub fn error_is_conflict_test() {
  error.StreamExists("http://example.com")
  |> error.is_conflict
  |> should.be_true

  error.SeqConflict("http://example.com")
  |> error.is_conflict
  |> should.be_true

  error.StreamNotFound("http://example.com")
  |> error.is_conflict
  |> should.be_false
}

pub fn error_is_retryable_test() {
  error.RateLimited("http://example.com", option.None)
  |> error.is_retryable
  |> should.be_true

  error.NetworkError("http://example.com", "connection refused")
  |> error.is_retryable
  |> should.be_true

  error.StreamNotFound("http://example.com")
  |> error.is_retryable
  |> should.be_false
}

pub fn error_to_string_test() {
  error.StreamNotFound("http://example.com/stream")
  |> error.to_string
  |> should.equal("Stream not found: http://example.com/stream")
}

// Options tests

pub fn default_create_options_test() {
  let opts = types.default_create_options()
  opts.content_type
  |> should.equal(types.ContentTypeOctetStream)
}

pub fn default_read_options_test() {
  let opts = types.default_read_options()
  opts.offset
  |> types.is_start_offset
  |> should.be_true

  opts.live
  |> should.equal(types.LiveModeNone)
}
