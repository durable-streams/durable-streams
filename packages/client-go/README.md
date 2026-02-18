# Durable Streams Go Client

Go client for the [Durable Streams](https://github.com/durable-streams/durable-streams) protocol — HTTP-based durable streams for reliable data delivery with offset-based resumability.

## Installation

```bash
go get github.com/durable-streams/durable-streams/packages/client-go
```

**Requirements:** Go 1.21+

## Quick Start

### Create a Client and Stream

```go
package main

import (
    "context"
    "fmt"

    durablestreams "github.com/durable-streams/durable-streams/packages/client-go"
)

func main() {
    client := durablestreams.NewClient()
    stream := client.Stream("https://streams.example.com/my-stream")

    ctx := context.Background()

    // Create a JSON stream
    err := stream.Create(ctx, durablestreams.WithContentType("application/json"))
    if err != nil {
        panic(err)
    }

    // Append data
    result, err := stream.Append(ctx, []byte(`{"event": "hello"}`))
    if err != nil {
        panic(err)
    }
    fmt.Println("Next offset:", result.NextOffset)
}
```

### Reading with Iterators

```go
it := stream.Read(ctx)
defer it.Close()

for {
    chunk, err := it.Next()
    if errors.Is(err, durablestreams.Done) {
        break
    }
    if err != nil {
        return err
    }
    fmt.Println(string(chunk.Data))

    // Save for resumption
    saveOffset(chunk.NextOffset)
}
```

### Go 1.23+ Range Iterators

With Go 1.23+, use `for range` syntax:

```go
for chunk, err := range stream.Chunks(ctx) {
    if err != nil {
        return err
    }
    process(chunk.Data)
}
```

### JSON Iteration

```go
type Event struct {
    Type string `json:"type"`
    Data string `json:"data"`
}

// Iterate over individual JSON items (arrays are flattened)
for event, err := range durablestreams.JSONItems[Event](ctx, stream) {
    if err != nil {
        return err
    }
    process(event)
}

// Or iterate over batches for offset tracking
for batch, err := range durablestreams.JSONBatches[Event](ctx, stream) {
    if err != nil {
        return err
    }
    for _, event := range batch.Items {
        process(event)
    }
    saveOffset(batch.NextOffset)
}
```

### Live Tailing

```go
// Long-poll: server holds connection until new data arrives
it := stream.Read(ctx, durablestreams.WithLive(durablestreams.LiveModeLongPoll))
defer it.Close()

for {
    chunk, err := it.Next()
    if errors.Is(err, durablestreams.Done) {
        break
    }
    if err != nil {
        return err
    }
    fmt.Println(string(chunk.Data))
    if chunk.UpToDate {
        fmt.Println("Caught up! Now tailing for new data...")
    }
}
```

SSE mode is also available for `text/*` and `application/json` streams:

```go
it := stream.Read(ctx, durablestreams.WithLive(durablestreams.LiveModeSSE))
```

### Resuming from an Offset

```go
savedOffset := durablestreams.Offset("abc123xyz")

it := stream.Read(ctx,
    durablestreams.WithOffset(savedOffset),
    durablestreams.WithLive(durablestreams.LiveModeLongPoll),
)
defer it.Close()
```

### Exactly-Once Writes with IdempotentProducer

For high-throughput writes with exactly-once delivery guarantees:

```go
producer := client.IdempotentProducer(
    "https://streams.example.com/my-stream",
    "order-service-1",
    durablestreams.IdempotentProducerConfig{
        Epoch:     0,
        AutoClaim: true,
    },
)
defer producer.Close()

// Fire-and-forget writes — batched and pipelined automatically
result1, err := producer.Append(ctx, []byte(`{"event":"order.created"}`))
result2, err := producer.Append(ctx, []byte(`{"event":"order.updated"}`))

// Ensure all messages are delivered
err = producer.Flush(ctx)
```

The producer provides:

- **Batching**: Multiple appends are batched into single HTTP requests (default 1MB max batch, 5ms linger)
- **Pipelining**: Up to 5 concurrent batches in flight
- **Exactly-once**: Server deduplicates using `(producerId, epoch, seq)` tuples
- **Zombie fencing**: Stale producers are rejected via epoch validation
- **Auto-claim**: Optionally claim the epoch automatically on first write

## Client Options

```go
client := durablestreams.NewClient(
    durablestreams.WithBaseURL("https://streams.example.com"),
    durablestreams.WithHTTPClient(customHTTPClient),
    durablestreams.WithRetryPolicy(durablestreams.RetryPolicy{
        MaxRetries:   5,
        InitialDelay: 200 * time.Millisecond,
        MaxDelay:     30 * time.Second,
        Multiplier:   2.0,
    }),
)
```

## Error Handling

The package provides sentinel errors for common conditions:

```go
if errors.Is(err, durablestreams.ErrStreamNotFound) {
    // Stream doesn't exist (404)
}
if errors.Is(err, durablestreams.ErrStreamExists) {
    // Create conflict (409)
}
if errors.Is(err, durablestreams.ErrStreamClosed) {
    // Stream is closed, no more appends (409)
}
if errors.Is(err, durablestreams.ErrOffsetGone) {
    // Offset before retention window (410)
}
```

For detailed error information:

```go
var se *durablestreams.StreamError
if errors.As(err, &se) {
    fmt.Println("Operation:", se.Op)
    fmt.Println("Status:", se.StatusCode)
}
```

## Features

- **Zero dependencies** — uses only Go standard library (`net/http`)
- **Concurrency-safe** — `Client` and `IdempotentProducer` are safe for concurrent use
- **Iterator-based reads** — `it.Next()` / `Done` sentinel pattern, plus Go 1.23+ `for range` support
- **Functional options** — `WithLive()`, `WithOffset()`, `WithContentType()`, etc.
- **Connection pooling** — optimized HTTP transport with 100 idle connections
- **Automatic retry** — configurable exponential backoff for transient failures
- **JSON generics** — type-safe `JSONItems[T]` and `JSONBatches[T]` with Go 1.21+ generics

## Stream Lifecycle

```go
// Create
err := stream.Create(ctx, durablestreams.WithContentType("application/json"))

// Get metadata
meta, err := stream.Head(ctx)
fmt.Println("Content-Type:", meta.ContentType)
fmt.Println("Next offset:", meta.NextOffset)

// Close (no more appends)
err = stream.Close(ctx)

// Close with final message
err = stream.Close(ctx, durablestreams.WithCloseData([]byte(`{"done":true}`)))

// Delete
err = stream.Delete(ctx)
```
