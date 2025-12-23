//go:build go1.23

package durablestreams

import (
	"context"
	"errors"
	"iter"
)

// Chunks returns an iterator over raw byte chunks from the stream.
// Use with Go 1.23+ for range syntax:
//
//	for chunk, err := range stream.Chunks(ctx) {
//	    if err != nil {
//	        return err
//	    }
//	    process(chunk.Data)
//	}
//
// The iterator automatically handles:
//   - Cursor propagation for CDN compatibility
//   - SSE/long-poll mode selection
//   - Reconnection on transient errors
func (s *Stream) Chunks(ctx context.Context, opts ...ReadOption) iter.Seq2[*Chunk, error] {
	return func(yield func(*Chunk, error) bool) {
		it := s.Read(ctx, opts...)
		defer it.Close()

		for {
			chunk, err := it.Next()
			if errors.Is(err, Done) {
				return
			}
			if !yield(chunk, err) {
				return
			}
			if err != nil {
				return
			}
		}
	}
}

// JSONItems returns an iterator over individual JSON items from the stream.
// Items from batches are automatically flattened.
//
// Use with Go 1.23+ for range syntax:
//
//	type Event struct {
//	    Type string `json:"type"`
//	    Data string `json:"data"`
//	}
//
//	for event, err := range JSONItems[Event](ctx, stream) {
//	    if err != nil {
//	        return err
//	    }
//	    process(event)
//	}
func JSONItems[T any](ctx context.Context, stream *Stream, opts ...ReadOption) iter.Seq2[T, error] {
	return func(yield func(T, error) bool) {
		it := ReadJSON[T](ctx, stream, opts...)
		defer it.Close()

		for {
			batch, err := it.Next()
			if errors.Is(err, Done) {
				return
			}
			if err != nil {
				var zero T
				if !yield(zero, err) {
					return
				}
				return
			}

			for _, item := range batch.Items {
				if !yield(item, nil) {
					return
				}
			}
		}
	}
}

// JSONBatches returns an iterator over JSON batches from the stream.
// Each batch contains items from a single HTTP response.
//
// Use with Go 1.23+ for range syntax:
//
//	for batch, err := range JSONBatches[Event](ctx, stream) {
//	    if err != nil {
//	        return err
//	    }
//	    for _, event := range batch.Items {
//	        process(event)
//	    }
//	}
func JSONBatches[T any](ctx context.Context, stream *Stream, opts ...ReadOption) iter.Seq2[*Batch[T], error] {
	return func(yield func(*Batch[T], error) bool) {
		it := ReadJSON[T](ctx, stream, opts...)
		defer it.Close()

		for {
			batch, err := it.Next()
			if errors.Is(err, Done) {
				return
			}
			if !yield(batch, err) {
				return
			}
			if err != nil {
				return
			}
		}
	}
}
