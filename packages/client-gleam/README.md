# Durable Streams Client for Gleam

A Gleam client library for the [Durable Streams protocol](../../PROTOCOL.md), an HTTP-based protocol for creating, appending to, and reading from durable, append-only streams.

## Installation

Add `durable_streams` to your `gleam.toml` dependencies:

```toml
[dependencies]
durable_streams = ">= 0.1.0"
```

Or install via the command line:

```sh
gleam add durable_streams
```

## Quick Start

```gleam
import durable_streams/client
import durable_streams/stream
import durable_streams/types
import gleam/json
import gleam/io

pub fn main() {
  // Create a client
  let c = client.new()

  // Get a stream handle (no network call yet)
  let my_stream = client.get_stream(c, "https://example.com/v1/stream/my-stream")

  // Create the stream as JSON type
  let assert Ok(my_stream) = stream.create_json(my_stream)

  // Append data
  let assert Ok(result) = stream.append_json_default(my_stream, json.object([
    #("event", json.string("user.created")),
    #("user_id", json.string("123")),
  ]))
  io.println("Next offset: " <> types.offset_to_string(result.next_offset))

  // Read from the stream
  let assert Ok(response) = stream.read_from_start(my_stream)
  case response {
    types.ReadData(chunk) -> {
      io.println("Got data!")
      io.println("Up to date: " <> case chunk.up_to_date {
        True -> "yes"
        False -> "no"
      })
    }
    types.ReadEmpty(_) -> io.println("No data yet")
    types.ReadTimeout(_) -> io.println("Timeout")
  }
}
```

## Features

- **Full protocol support**: Create, append, read, delete, and head operations
- **JSON mode**: Automatic JSON encoding/decoding with message boundary preservation
- **Live tailing**: Long-poll and SSE support for real-time streaming
- **Iterator API**: Convenient iteration over stream chunks
- **Error handling**: Typed errors with pattern matching
- **Offset tracking**: Opaque offset tokens for resumable reads

## API Overview

### Client

```gleam
import durable_streams/client

// Create with defaults
let c = client.new()

// Create with base URL
let c = client.new_with_base_url("https://api.example.com")

// Create with custom options
let c = client.new_with_options(client.ClientOptions(
  base_url: option.Some("https://api.example.com"),
  timeout_ms: 60_000,
  max_retries: 5,
  default_headers: [#("Authorization", "Bearer token")],
))

// Get a stream handle
let my_stream = client.get_stream(c, "/v1/stream/my-stream")
```

### Stream Operations

```gleam
import durable_streams/stream
import durable_streams/types

// Create a stream
let assert Ok(s) = stream.create(my_stream, types.CreateOptions(
  content_type: types.ContentTypeJson,
  ttl_seconds: option.Some(86400),  // 24 hours
  expires_at: option.None,
  initial_data: option.None,
  headers: [],
))

// Or use convenience functions
let assert Ok(s) = stream.create_json(my_stream)
let assert Ok(s) = stream.create_default(my_stream)  // octet-stream

// Append data
let assert Ok(result) = stream.append_default(my_stream, <<"hello">>)
let assert Ok(result) = stream.append_json_default(my_stream, json.string("hello"))

// With options
let assert Ok(result) = stream.append(my_stream, data, types.AppendOptions(
  seq: option.Some("seq-001"),  // For writer coordination
  if_match: option.None,
  headers: [],
))

// Get metadata
let assert Ok(meta) = stream.head(my_stream)
io.println("Content-Type: " <> types.content_type_to_string(meta.content_type))
io.println("Next offset: " <> types.offset_to_string(meta.next_offset))

// Delete
let assert Ok(Nil) = stream.delete(my_stream)
```

### Reading Data

```gleam
import durable_streams/stream
import durable_streams/types

// Read from the start (catch-up mode)
let assert Ok(response) = stream.read_from_start(my_stream)

// Read from a specific offset
let assert Ok(response) = stream.read_from_offset(my_stream, saved_offset)

// Read with live tailing (long-poll)
let assert Ok(response) = stream.read_live(my_stream, current_offset)

// Read with full options
let assert Ok(response) = stream.read(my_stream, types.ReadOptions(
  offset: types.start_offset(),
  live: types.LiveModeLongPoll,
  cursor: option.None,
  timeout_ms: option.Some(30_000),
  headers: [],
))

// Handle response
case response {
  types.ReadData(chunk) -> {
    // Process chunk.data (BitArray)
    let next = chunk.next_offset  // Save for resumption
  }
  types.ReadEmpty(offset) -> {
    // No data available (catch-up mode at end)
  }
  types.ReadTimeout(offset) -> {
    // Long-poll timeout, retry with same offset
  }
}
```

### Iterator API

For convenient iteration over stream data:

```gleam
import durable_streams/iterator
import durable_streams/types

// Create an iterator
let iter = iterator.new(my_stream, types.start_offset(), types.LiveModeNone)

// Iterate manually
case iterator.next(iter) {
  Ok(#(chunk, new_iter)) -> {
    // Process chunk
    // Continue with new_iter
  }
  Error(err) -> {
    // Handle error
  }
}

// Collect all chunks (non-live mode)
let assert Ok(chunks) = iterator.collect_all(iter)

// Process with callback
let assert Ok(final_iter) = iterator.for_each(iter, fn(chunk) {
  io.println("Got chunk!")
  True  // Continue, or False to stop
})

// Parse JSON items
let decoder = dynamic.field("event", dynamic.string)
let assert Ok(events) = iterator.collect_json_items(iter, decoder)
```

### Error Handling

```gleam
import durable_streams/error

case stream.read_from_start(my_stream) {
  Ok(response) -> // Handle success
  Error(err) -> {
    case err {
      error.StreamNotFound(_) -> io.println("Stream doesn't exist")
      error.RateLimited(_, retry_after) -> io.println("Rate limited")
      error.OffsetGone(_, offset) -> io.println("Offset before retention")
      error.NetworkError(_, msg) -> io.println("Network error: " <> msg)
      _ -> io.println(error.to_string(err))
    }

    // Or use helper functions
    case error.is_retryable(err) {
      True -> // Retry the operation
      False -> // Fail
    }
  }
}
```

## Offsets

Offsets are opaque tokens that identify positions within a stream:

```gleam
import durable_streams/types

// Start from beginning
let start = types.start_offset()

// Restore a saved offset
let saved = types.offset("abc123")

// Convert to string for persistence
let offset_str = types.offset_to_string(my_offset)

// Compare offsets (lexicographic)
case types.compare_offsets(a, b) {
  order.Lt -> // a is before b
  order.Eq -> // same position
  order.Gt -> // a is after b
}
```

## Content Types

The protocol supports various content types:

```gleam
import durable_streams/types

// Built-in types
types.ContentTypeOctetStream  // application/octet-stream (default)
types.ContentTypeJson         // application/json (with message boundaries)
types.ContentTypeNdJson       // application/x-ndjson
types.ContentTypeText         // text/plain

// Custom type
types.ContentTypeCustom("application/x-protobuf")
```

JSON mode (`ContentTypeJson`) preserves message boundaries - each append is stored as a distinct message, and reads return JSON arrays.

## Live Streaming Modes

```gleam
import durable_streams/types

// No live streaming (catch-up only)
types.LiveModeNone

// HTTP long-polling (works with all content types)
types.LiveModeLongPoll

// Server-Sent Events (for text/* and application/json only)
types.LiveModeSSE
```

## Requirements

- Gleam 1.0+
- Erlang/OTP 25+ (for `gleam_httpc`)

## License

MIT License - see [LICENSE](../../LICENSE) for details.
