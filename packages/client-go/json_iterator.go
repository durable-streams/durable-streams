package durablestreams

import (
	"context"
	"encoding/json"
	"errors"
	"io"
)

// Batch contains parsed JSON items from one HTTP response.
// Each batch corresponds to a single chunk from the stream.
type Batch[T any] struct {
	// Items are the parsed JSON values from this response.
	// Per protocol spec, top-level arrays are flattened one level.
	Items []T

	// NextOffset is the position after this batch.
	// Use this for resumption/checkpointing.
	NextOffset Offset

	// UpToDate is true if this batch ends at stream head.
	UpToDate bool

	// Cursor for CDN collapsing (automatically propagated by iterator).
	Cursor string
}

// JSONBatchIterator iterates over JSON batches from a stream.
// Each batch corresponds to one HTTP response containing JSON data.
// Top-level arrays in the response are automatically flattened.
//
// Example:
//
//	type Event struct {
//	    Type string `json:"type"`
//	    Data string `json:"data"`
//	}
//
//	it := stream.ReadJSON[Event](ctx)
//	defer it.Close()
//
//	for {
//	    batch, err := it.Next()
//	    if errors.Is(err, durablestreams.Done) {
//	        break
//	    }
//	    if err != nil {
//	        return err
//	    }
//	    for _, event := range batch.Items {
//	        process(event)
//	    }
//	}
type JSONBatchIterator[T any] struct {
	chunks *ChunkIterator

	// Public state mirrored from underlying iterator
	// Offset is the current position in the stream.
	Offset Offset

	// UpToDate is true when the iterator has caught up to stream head.
	UpToDate bool

	// Cursor is the current cursor value (for debugging/advanced use).
	Cursor string
}

// newJSONBatchIterator creates a new JSON batch iterator wrapping a chunk iterator.
func newJSONBatchIterator[T any](chunks *ChunkIterator) *JSONBatchIterator[T] {
	return &JSONBatchIterator[T]{
		chunks:   chunks,
		Offset:   chunks.Offset,
		UpToDate: chunks.UpToDate,
		Cursor:   chunks.Cursor,
	}
}

// Next returns the next batch of JSON items from the stream.
// Returns Done when iteration is complete.
// In live mode, blocks waiting for new data.
//
// Each batch contains items parsed from a single HTTP response.
// If the response body is a JSON array, items are flattened into the batch.
// If it's a single JSON object, the batch contains one item.
func (it *JSONBatchIterator[T]) Next() (*Batch[T], error) {
	chunk, err := it.chunks.Next()
	if err != nil {
		return nil, err
	}

	// Skip empty chunks (e.g., 204 responses in live mode)
	if len(chunk.Data) == 0 {
		// Update state and return empty batch
		it.Offset = chunk.NextOffset
		it.UpToDate = chunk.UpToDate
		it.Cursor = chunk.Cursor
		return &Batch[T]{
			Items:      nil,
			NextOffset: chunk.NextOffset,
			UpToDate:   chunk.UpToDate,
			Cursor:     chunk.Cursor,
		}, nil
	}

	// Parse JSON from chunk data
	items, err := parseJSONBatch[T](chunk.Data)
	if err != nil {
		return nil, newStreamError("read", it.chunks.stream.url, 0, err)
	}

	// Update iterator state
	it.Offset = chunk.NextOffset
	it.UpToDate = chunk.UpToDate
	it.Cursor = chunk.Cursor

	return &Batch[T]{
		Items:      items,
		NextOffset: chunk.NextOffset,
		UpToDate:   chunk.UpToDate,
		Cursor:     chunk.Cursor,
	}, nil
}

// Close cancels the iterator and releases resources.
// Always call Close when done, even if iteration completed.
// Implements io.Closer.
func (it *JSONBatchIterator[T]) Close() error {
	return it.chunks.Close()
}

// Ensure JSONBatchIterator implements io.Closer
var _ io.Closer = (*JSONBatchIterator[any])(nil)

// parseJSONBatch parses JSON data, flattening top-level arrays.
// Per protocol spec, top-level arrays are flattened one level.
func parseJSONBatch[T any](data []byte) ([]T, error) {
	// First, try to parse as array
	var items []T
	if err := json.Unmarshal(data, &items); err == nil {
		return items, nil
	}

	// If that fails, try to parse as single item
	var item T
	if err := json.Unmarshal(data, &item); err != nil {
		return nil, errors.New("invalid JSON: " + err.Error())
	}

	return []T{item}, nil
}

// ReadJSON returns an iterator for reading JSON batches.
// Only valid for streams with Content-Type: application/json.
//
// Example:
//
//	type Event struct {
//	    Type string `json:"type"`
//	    Data string `json:"data"`
//	}
//
//	it := stream.ReadJSON[Event](ctx)
//	defer it.Close()
//
//	for {
//	    batch, err := it.Next()
//	    if errors.Is(err, durablestreams.Done) {
//	        break
//	    }
//	    for _, event := range batch.Items {
//	        fmt.Println(event.Type, event.Data)
//	    }
//	}
func ReadJSON[T any](ctx context.Context, stream *Stream, opts ...ReadOption) *JSONBatchIterator[T] {
	chunks := stream.Read(ctx, opts...)
	return newJSONBatchIterator[T](chunks)
}

// Items returns a channel that yields individual items from the stream.
// This is a convenience wrapper that flattens batches into individual items.
// The channel is closed when iteration completes or an error occurs.
// Errors are reported via the second return value channel.
//
// Example:
//
//	items, errs := durablestreams.Items[Event](ctx, stream)
//	for {
//	    select {
//	    case item, ok := <-items:
//	        if !ok {
//	            return nil // Done
//	        }
//	        process(item)
//	    case err := <-errs:
//	        return err
//	    }
//	}
func Items[T any](ctx context.Context, stream *Stream, opts ...ReadOption) (<-chan T, <-chan error) {
	items := make(chan T)
	errs := make(chan error, 1)

	go func() {
		defer close(items)
		defer close(errs)

		it := ReadJSON[T](ctx, stream, opts...)
		defer it.Close()

		for {
			batch, err := it.Next()
			if errors.Is(err, Done) {
				return
			}
			if err != nil {
				errs <- err
				return
			}

			for _, item := range batch.Items {
				select {
				case items <- item:
				case <-ctx.Done():
					errs <- ctx.Err()
					return
				}
			}
		}
	}()

	return items, errs
}
