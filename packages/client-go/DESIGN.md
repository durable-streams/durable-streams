# Go Client Library Design for Durable Streams

## Overview

This document proposes a design for a Go client library implementing the Durable Streams Protocol. The design draws from:

- The existing TypeScript client in this repo
- The Python client PR (#83)
- The community Go implementation (ahimsalabs/durable-streams-go)
- Best practices from aws-sdk-go, google-cloud-go, and idiomatic Go patterns

## Design Goals

1. **Idiomatic Go** - Follow established Go conventions (context, errors, interfaces)
2. **Minimal dependencies** - Standard library only (no external deps)
3. **Type safety** - Leverage Go's type system effectively
4. **Performance** - Efficient streaming without buffering entire responses
5. **Testability** - Easy to mock and test
6. **Conformance** - Pass all protocol conformance tests
7. **Protocol accuracy** - API reflects actual protocol semantics (chunks/batches, not abstract "messages")

---

## Option A: Google Cloud Style (Recommended)

This approach follows patterns from google-cloud-go, the most widely adopted Go SDK style.

### Package Structure

```
packages/client-go/
├── go.mod                    # github.com/durable-streams/durable-streams/packages/client-go
├── go.sum
├── client.go                 # Client type and constructor
├── stream.go                 # Stream handle
├── iterator.go               # Iterator types (ChunkIterator, JSONBatchIterator)
├── options.go                # Functional options
├── errors.go                 # Error types
├── doc.go                    # Package documentation
├── internal/
│   ├── sse/
│   │   └── parser.go         # SSE event parsing
│   └── backoff/
│       └── backoff.go        # Retry with exponential backoff
└── durablestreamstest/       # Testing utilities (mock client)
    └── mock.go
```

### Core Types

```go
package durablestreams

import (
    "context"
    "io"
    "net/http"
    "time"
)

// Offset is an opaque position token in a stream.
// Use StartOffset to read from the beginning.
type Offset string

const StartOffset Offset = "-1"

// Done is returned by iterators when iteration is complete.
// Check with errors.Is(err, durablestreams.Done).
var Done = errors.New("durablestreams: no more items in iterator")

// Client is a durable streams client.
// It is safe for concurrent use.
type Client struct {
    httpClient *http.Client
    // ... internal fields
}

// NewClient creates a new durable streams client.
func NewClient(opts ...ClientOption) *Client

// Stream returns a handle to a stream at the given URL.
// No network request is made until an operation is called.
func (c *Client) Stream(url string) *Stream

// Stream represents a durable stream handle.
// It is a lightweight, reusable object - not a persistent connection.
type Stream struct {
    url    string
    client *Client
}
```

### Stream Operations

```go
// Create creates a new stream (idempotent).
// Succeeds if the stream already exists with matching config.
// Returns ErrStreamExists only if config differs (409 Conflict).
func (s *Stream) Create(ctx context.Context, opts ...CreateOption) error

// Append writes data to the stream and returns the result.
// The AppendResult contains the NextOffset for checkpointing.
func (s *Stream) Append(ctx context.Context, data []byte, opts ...AppendOption) (*AppendResult, error)

// AppendJSON writes JSON data to the stream.
// For JSON streams, arrays are flattened one level per protocol spec.
func (s *Stream) AppendJSON(ctx context.Context, v any, opts ...AppendOption) (*AppendResult, error)

// AppendResult contains the response from an append operation.
type AppendResult struct {
    // NextOffset is the tail offset after this append.
    // Use this for checkpointing or exactly-once semantics.
    NextOffset Offset

    // ETag for conditional requests (if returned by server).
    ETag string
}

// Delete removes the stream.
func (s *Stream) Delete(ctx context.Context) error

// Head returns stream metadata without reading content.
func (s *Stream) Head(ctx context.Context) (*Metadata, error)

// Metadata contains stream information from HEAD request.
type Metadata struct {
    ContentType string
    NextOffset  Offset
    TTL         *time.Duration
    ExpiresAt   *time.Time
    ETag        string
}
```

### Reading - Chunk Iterator (Primary API)

The protocol operates at the byte/chunk level. The primary read abstraction reflects this:

```go
// Read returns an iterator for reading stream chunks.
// Each chunk corresponds to one HTTP response body.
// The iterator handles catch-up, live tailing, and cursor propagation automatically.
func (s *Stream) Read(ctx context.Context, opts ...ReadOption) *ChunkIterator

// ChunkIterator iterates over raw byte chunks from the stream.
// Call Next() in a loop until it returns Done.
//
// The iterator automatically:
// - Propagates cursor headers for CDN compatibility
// - Handles 304 Not Modified responses (advances state, no error)
// - Retries transient errors with backoff
type ChunkIterator struct {
    // Offset is the current position in the stream.
    // Updated after each successful Next() call.
    Offset Offset

    // UpToDate is true when the iterator has caught up to stream head.
    UpToDate bool

    // Cursor is the current cursor value (for debugging/advanced use).
    // The iterator propagates this automatically; most users can ignore it.
    Cursor string

    // ... internal fields
}

// Next returns the next chunk of bytes from the stream.
// Returns Done when iteration is complete (live=false and caught up).
// In live mode, blocks waiting for new data.
func (it *ChunkIterator) Next() (*Chunk, error)

// Close cancels the iterator and releases resources.
// Always call Close when done, even if iteration completed.
// Implements io.Closer.
func (it *ChunkIterator) Close() error

// Chunk represents one HTTP response body from the stream.
type Chunk struct {
    // NextOffset is the position after this chunk.
    // Use this for resumption/checkpointing.
    NextOffset Offset

    // Data is the raw bytes from this response.
    Data []byte

    // UpToDate is true if this chunk ends at stream head.
    UpToDate bool

    // Cursor for CDN collapsing (automatically propagated by iterator).
    Cursor string

    // ETag for conditional requests.
    ETag string
}
```

### Reading - JSON Batch Iterator (For JSON Mode)

For `application/json` streams, provide a typed batch iterator:

```go
// ReadJSON returns an iterator for reading JSON batches.
// Only valid for streams with Content-Type: application/json.
// Each batch contains the items from one HTTP response.
func (s *Stream) ReadJSON[T any](ctx context.Context, opts ...ReadOption) *JSONBatchIterator[T]

// JSONBatchIterator iterates over JSON batches from a stream.
// Each batch corresponds to one HTTP response containing a JSON array.
type JSONBatchIterator[T any] struct {
    // Offset is the current position in the stream.
    Offset Offset

    // UpToDate is true when caught up to stream head.
    UpToDate bool

    // Cursor for CDN collapsing.
    Cursor string
}

// Next returns the next batch of JSON items.
// Returns Done when iteration is complete.
func (it *JSONBatchIterator[T]) Next() (*Batch[T], error)

// Close releases resources. Implements io.Closer.
func (it *JSONBatchIterator[T]) Close() error

// Batch contains parsed JSON items from one HTTP response.
type Batch[T any] struct {
    // NextOffset for resumption/checkpointing.
    NextOffset Offset

    // Items are the parsed JSON values from this response.
    Items []T

    // UpToDate is true if this batch ends at stream head.
    UpToDate bool

    // Cursor for CDN collapsing.
    Cursor string
}
```

### Live Modes

```go
type LiveMode string

const (
    // LiveModeNone stops after catching up (no live tailing).
    LiveModeNone LiveMode = ""

    // LiveModeLongPoll uses HTTP long-polling for live updates.
    LiveModeLongPoll LiveMode = "long-poll"

    // LiveModeSSE uses Server-Sent Events for live updates.
    LiveModeSSE LiveMode = "sse"

    // LiveModeAuto selects the best mode based on content type.
    // Uses SSE for text/* and application/json, long-poll otherwise.
    // Falls back to long-poll if SSE fails.
    LiveModeAuto LiveMode = "auto"
)
```

### Functional Options

```go
// Client options
type ClientOption func(*clientConfig)

func WithHTTPClient(c *http.Client) ClientOption
func WithBaseURL(url string) ClientOption
func WithRetryPolicy(p RetryPolicy) ClientOption

// Create options
type CreateOption func(*createConfig)

func WithContentType(ct string) CreateOption
func WithTTL(d time.Duration) CreateOption
func WithExpiresAt(t time.Time) CreateOption
func WithInitialData(data []byte) CreateOption

// Append options
type AppendOption func(*appendConfig)

func WithSeq(seq string) AppendOption
func WithIfMatch(etag string) AppendOption  // For optimistic concurrency

// Read options
type ReadOption func(*readConfig)

func WithOffset(o Offset) ReadOption
func WithLive(mode LiveMode) ReadOption
func WithCursor(cursor string) ReadOption  // For manual cursor control (advanced)
```

### Error Handling

```go
import "errors"

// Sentinel errors following Go conventions
var (
    // Done is returned by iterators when iteration is complete.
    Done = errors.New("durablestreams: no more items in iterator")

    // ErrStreamNotFound indicates the stream does not exist (404).
    ErrStreamNotFound = errors.New("durablestreams: stream not found")

    // ErrStreamExists indicates a create conflict with different config (409).
    ErrStreamExists = errors.New("durablestreams: stream already exists with different config")

    // ErrSeqConflict indicates a sequence ordering violation (409).
    ErrSeqConflict = errors.New("durablestreams: sequence conflict")

    // ErrOffsetGone indicates the offset is before retained data (410).
    ErrOffsetGone = errors.New("durablestreams: offset before retention window")

    // ErrRateLimited indicates rate limiting (429).
    ErrRateLimited = errors.New("durablestreams: rate limited")

    // ErrContentTypeMismatch indicates append content type doesn't match stream (409).
    ErrContentTypeMismatch = errors.New("durablestreams: content type mismatch")
)

// StreamError wraps errors with additional context.
type StreamError struct {
    Op         string // "create", "append", "read", "delete", "head"
    URL        string
    StatusCode int
    Err        error
}

func (e *StreamError) Error() string
func (e *StreamError) Unwrap() error

// Usage:
// if errors.Is(err, ErrStreamNotFound) { ... }
// var se *StreamError
// if errors.As(err, &se) { fmt.Println(se.StatusCode) }
```

### Example Usage

```go
package main

import (
    "context"
    "errors"
    "fmt"
    "log"
    "time"

    ds "github.com/durable-streams/durable-streams/packages/client-go"
)

func main() {
    ctx := context.Background()

    // Create client (zero external dependencies)
    client := ds.NewClient()

    // Get stream handle
    stream := client.Stream("https://example.com/streams/my-stream")

    // Create the stream (idempotent - succeeds if same config exists)
    err := stream.Create(ctx,
        ds.WithContentType("application/json"),
        ds.WithTTL(24*time.Hour),
    )
    if err != nil {
        log.Fatal(err)
    }

    // Append data - returns NextOffset for checkpointing
    result, err := stream.AppendJSON(ctx, map[string]any{
        "event": "user.created",
        "user":  "alice",
    })
    if err != nil {
        log.Fatal(err)
    }
    fmt.Printf("Appended, next offset: %s\n", result.NextOffset)

    // Read JSON batches (catch-up only)
    it := stream.ReadJSON[map[string]any](ctx)
    defer it.Close()

    for {
        batch, err := it.Next()
        if errors.Is(err, ds.Done) {
            break
        }
        if err != nil {
            log.Fatal(err)
        }
        for _, item := range batch.Items {
            fmt.Printf("Item: %v\n", item)
        }
        fmt.Printf("Batch offset: %s, up-to-date: %v\n", batch.NextOffset, batch.UpToDate)
    }

    // Live tailing with long-poll
    it2 := stream.ReadJSON[Event](ctx, ds.WithLive(ds.LiveModeLongPoll))
    defer it2.Close()

    for {
        batch, err := it2.Next()
        if errors.Is(err, ds.Done) {
            break
        }
        if err != nil {
            log.Fatal(err)
        }
        for _, event := range batch.Items {
            fmt.Printf("Event: %+v\n", event)
        }
    }
}

type Event struct {
    Type string `json:"event"`
    User string `json:"user"`
}
```

---

## Option B: Simpler API (aws-sdk-go Style)

This approach is more direct with fewer abstractions.

### Core Types

```go
package durablestreams

// Client with direct methods
type Client struct {
    BaseURL    string
    HTTPClient *http.Client
}

// Direct operations without Stream handle
func (c *Client) CreateStream(ctx context.Context, url string, opts *CreateOptions) error
func (c *Client) Append(ctx context.Context, url string, data []byte, opts *AppendOptions) (*AppendResult, error)
func (c *Client) Read(ctx context.Context, url string, opts *ReadOptions) (*ReadResult, error)
func (c *Client) Delete(ctx context.Context, url string) error
func (c *Client) Head(ctx context.Context, url string) (*Metadata, error)

// Options as structs instead of functional options
type CreateOptions struct {
    ContentType string
    TTL         time.Duration
    ExpiresAt   time.Time
    InitialData []byte
}

type ReadOptions struct {
    Offset Offset
    Live   LiveMode
    Cursor string
}

// ReadResult exposes the raw response for advanced use
type ReadResult struct {
    Body       io.ReadCloser
    NextOffset Offset
    Cursor     string
    UpToDate   bool
    StatusCode int
    Headers    http.Header
    ETag       string
}

// JSONBatches returns an iterator over JSON batches
func (r *ReadResult) JSONBatches() <-chan BatchOrError[any]
```

### Example Usage

```go
client := &durablestreams.Client{
    HTTPClient: &http.Client{Timeout: 30 * time.Second},
}

err := client.CreateStream(ctx, "https://example.com/stream", &durablestreams.CreateOptions{
    ContentType: "application/json",
})

result, err := client.Append(ctx, "https://example.com/stream", data, nil)
fmt.Printf("Next offset: %s\n", result.NextOffset)

readResult, err := client.Read(ctx, "https://example.com/stream", &durablestreams.ReadOptions{
    Live: durablestreams.LiveModeLongPoll,
})
defer readResult.Body.Close()

for batch := range readResult.JSONBatches() {
    if batch.Err != nil {
        log.Fatal(batch.Err)
    }
    fmt.Println(batch.Items)
}
```

---

## Option C: Go 1.23 Range-Over-Func (Modern Go)

Go 1.23 introduced range-over-func, allowing custom iterators with `for range`:

```go
package durablestreams

// Chunks returns an iterator for use with range.
// Go 1.23+ range-over-func pattern.
func (s *Stream) Chunks(ctx context.Context, opts ...ReadOption) iter.Seq2[*Chunk, error]

// JSONItems returns a flattened iterator over individual JSON items.
func (s *Stream) JSONItems[T any](ctx context.Context, opts ...ReadOption) iter.Seq2[T, error]

// Usage with Go 1.23+:
for chunk, err := range stream.Chunks(ctx, ds.WithLive(ds.LiveModeLongPoll)) {
    if err != nil {
        log.Fatal(err)
    }
    fmt.Println(string(chunk.Data))
}
```

### Tradeoff Analysis

| Feature         | Go 1.23 iter.Seq2   | Classic Iterator           |
| --------------- | ------------------- | -------------------------- |
| Syntax          | Clean `for range`   | `for { Next() }`           |
| Cleanup         | Automatic via break | Manual `Close()` required  |
| Go Version      | 1.23+ only          | Any version                |
| Ecosystem       | New pattern         | Well-established           |
| Cancel          | Via context         | Via context or Close()     |
| Metadata access | Need separate vars  | `it.Offset`, `it.UpToDate` |

**Recommendation**: Ship classic iterators as primary API. Add Go 1.23 range functions as additive API with build tags (`//go:build go1.23`) in a future phase.

---

## Recommendation

**Option A (Google Cloud Style)** is recommended because:

1. **Established pattern** - Widely used in google-cloud-go, battle-tested
2. **Explicit resource management** - `Close()` implements io.Closer
3. **Consistent with ecosystem** - Users familiar with GCP/AWS Go SDKs
4. **Metadata access** - Easy to check `it.UpToDate`, `it.Offset`, `it.Cursor` during iteration
5. **Compatible** - Works with all Go versions (1.21+)
6. **Zero dependencies** - Own `Done` sentinel, no external imports

### Implementation Phases

**Phase 1: Core Operations**

- Client + Stream types
- Create, Append (with AppendResult), Delete, Head
- ChunkIterator for catch-up reads
- Error types
- Automatic cursor propagation

**Phase 2: Live Streaming**

- Long-poll support
- SSE support with parser
- LiveModeAuto selection with fallback

**Phase 3: Advanced Features**

- JSONBatchIterator with generics
- Automatic batching for appends (like TS client)
- Retry with exponential backoff
- Connection pooling optimization

**Phase 4: Testing & Conformance**

- Pass conformance test suite
- Testing utilities (mock client)
- Documentation
- Optional: Go 1.23 range-over-func API (with build tags)

---

## Conformance Test Adapter

To pass the conformance tests, we need a stdin/stdout JSON adapter:

```go
// cmd/conformance-adapter/main.go
package main

// Implements the conformance test protocol:
// - Reads JSON operations from stdin
// - Executes against durable-streams client
// - Writes JSON results to stdout

type Operation struct {
    Type   string          `json:"type"`
    Create *CreateOp       `json:"create,omitempty"`
    Append *AppendOp       `json:"append,omitempty"`
    Read   *ReadOp         `json:"read,omitempty"`
    // ...
}

type CreateOp struct {
    URL         string `json:"url"`
    ContentType string `json:"contentType"`
    TTL         int    `json:"ttl,omitempty"`
}

// ... adapter implementation
```

---

## Dependencies

**Zero external dependencies** - standard library only:

```go
module github.com/durable-streams/durable-streams/packages/client-go

go 1.21

// No require block - stdlib only
```

---

## Design Decisions (Resolved)

1. **Minimum Go version**: 1.21 (current stable-1, good balance)

2. **Package structure**: Single `durablestreams` package + `durablestreamstest` for mocks

3. **Iterator sentinel**: Own `var Done = errors.New(...)` (zero deps)

4. **Primary read abstraction**: `ChunkIterator` (reflects protocol's byte-level semantics)
   - `JSONBatchIterator[T]` for typed JSON mode
   - Avoids misleading "message" terminology for byte streams

5. **Append return value**: `*AppendResult` with `NextOffset` and `ETag`

6. **Cursor handling**: Automatic propagation inside iterator (users don't wire it)

7. **Create semantics**: Single idempotent `Create()` (no separate CreateOrEnsure)

8. **Resource cleanup**: `Close() error` satisfying `io.Closer`

---

## References

- [Effective Go](https://go.dev/doc/effective_go)
- [Google Cloud Go Iterator Guidelines](https://github.com/googleapis/google-cloud-go/wiki/Iterator-Guidelines)
- [Functional Options Pattern](https://dev.to/kittipat1413/understanding-the-options-pattern-in-go-390c)
- [Go Context Best Practices](https://go.dev/blog/context)
- [Go HTTP Client Timeouts](https://blog.cloudflare.com/the-complete-guide-to-golang-net-http-timeouts/)
- [Designing Go Libraries](https://abhinavg.net/2022/12/06/designing-go-libraries/)
- [Go 1.23 Range Over Function Types](https://go.dev/blog/range-functions)
