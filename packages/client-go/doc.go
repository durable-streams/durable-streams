// Package durablestreams provides a Go client for the Durable Streams protocol.
//
// Durable Streams is an HTTP-based protocol for creating, appending to, and reading
// from durable, append-only byte streams. This client implements the protocol with
// support for catch-up reads and live tailing via long-poll or SSE.
//
// # Basic Usage
//
// Create a client and stream handle:
//
//	client := durablestreams.NewClient()
//	stream := client.Stream("https://example.com/streams/my-stream")
//
// Create a new stream:
//
//	err := stream.Create(ctx, durablestreams.WithContentType("application/json"))
//
// Append data:
//
//	result, err := stream.Append(ctx, []byte(`{"event": "test"}`))
//	fmt.Println("Next offset:", result.NextOffset)
//
// Read with iterator:
//
//	it := stream.Read(ctx)
//	defer it.Close()
//
//	for {
//	    chunk, err := it.Next()
//	    if errors.Is(err, durablestreams.Done) {
//	        break
//	    }
//	    if err != nil {
//	        return err
//	    }
//	    fmt.Println(string(chunk.Data))
//	}
//
// # Live Tailing
//
// For live updates, use WithLive option:
//
//	it := stream.Read(ctx, durablestreams.WithLive(durablestreams.LiveModeLongPoll))
//	defer it.Close()
//
//	for {
//	    chunk, err := it.Next()
//	    if errors.Is(err, durablestreams.Done) {
//	        break
//	    }
//	    // Process live updates...
//	}
//
// # Error Handling
//
// The package provides sentinel errors for common conditions:
//
//	if errors.Is(err, durablestreams.ErrStreamNotFound) {
//	    // Handle 404
//	}
//	if errors.Is(err, durablestreams.ErrStreamExists) {
//	    // Handle 409 conflict on create
//	}
//
// For detailed error information, use errors.As with StreamError:
//
//	var se *durablestreams.StreamError
//	if errors.As(err, &se) {
//	    fmt.Println("Status:", se.StatusCode)
//	}
package durablestreams
