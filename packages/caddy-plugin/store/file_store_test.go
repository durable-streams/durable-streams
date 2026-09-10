package store

import (
	"bytes"
	"context"
	"encoding/binary"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestFileStore_CreateAndGet(t *testing.T) {
	tmpDir, err := os.MkdirTemp("", "filestore-test-*")
	if err != nil {
		t.Fatalf("failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(tmpDir)

	store, err := NewFileStore(FileStoreConfig{DataDir: tmpDir})
	if err != nil {
		t.Fatalf("failed to create store: %v", err)
	}
	defer store.Close()

	// Create a stream
	opts := CreateOptions{
		ContentType: "application/json",
	}
	meta, created, err := store.Create("/test/stream", opts)
	if err != nil {
		t.Fatalf("Create failed: %v", err)
	}
	if !created {
		t.Error("expected created=true for new stream")
	}
	if meta.Path != "/test/stream" {
		t.Errorf("path mismatch: %q", meta.Path)
	}
	if meta.ContentType != "application/json" {
		t.Errorf("content type mismatch: %q", meta.ContentType)
	}

	// Get it back
	gotMeta, err := store.Get("/test/stream")
	if err != nil {
		t.Fatalf("Get failed: %v", err)
	}
	if gotMeta.Path != meta.Path {
		t.Errorf("path mismatch on get")
	}

	// Has should return true
	if !store.Has("/test/stream") {
		t.Error("Has returned false for existing stream")
	}

	// Get nonexistent
	_, err = store.Get("/nonexistent")
	if err != ErrStreamNotFound {
		t.Errorf("expected ErrStreamNotFound, got %v", err)
	}
}

func TestFileStore_CreateIdempotent(t *testing.T) {
	tmpDir, err := os.MkdirTemp("", "filestore-test-*")
	if err != nil {
		t.Fatalf("failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(tmpDir)

	store, err := NewFileStore(FileStoreConfig{DataDir: tmpDir})
	if err != nil {
		t.Fatalf("failed to create store: %v", err)
	}
	defer store.Close()

	opts := CreateOptions{ContentType: "text/plain"}

	// First create
	_, created1, err := store.Create("/test", opts)
	if err != nil {
		t.Fatalf("first Create failed: %v", err)
	}
	if !created1 {
		t.Error("first create should return created=true")
	}

	// Second create with same config
	_, created2, err := store.Create("/test", opts)
	if err != nil {
		t.Fatalf("second Create failed: %v", err)
	}
	if created2 {
		t.Error("idempotent create should return created=false")
	}

	// Create with different config
	opts.ContentType = "application/json"
	_, _, err = store.Create("/test", opts)
	if err != ErrConfigMismatch {
		t.Errorf("expected ErrConfigMismatch, got %v", err)
	}
}

func TestFileStore_AppendAndRead(t *testing.T) {
	tmpDir, err := os.MkdirTemp("", "filestore-test-*")
	if err != nil {
		t.Fatalf("failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(tmpDir)

	store, err := NewFileStore(FileStoreConfig{DataDir: tmpDir})
	if err != nil {
		t.Fatalf("failed to create store: %v", err)
	}
	defer store.Close()

	// Create stream
	_, _, err = store.Create("/test", CreateOptions{ContentType: "text/plain"})
	if err != nil {
		t.Fatalf("Create failed: %v", err)
	}

	// Append
	data := []byte("hello world")
	result, err := store.Append("/test", data, AppendOptions{})
	if err != nil {
		t.Fatalf("Append failed: %v", err)
	}
	if result.Offset.ByteOffset == 0 {
		t.Error("offset should be non-zero after append")
	}

	// Read from start
	messages, upToDate, err := store.Read("/test", ZeroOffset)
	if err != nil {
		t.Fatalf("Read failed: %v", err)
	}
	if len(messages) != 1 {
		t.Errorf("expected 1 message, got %d", len(messages))
	}
	if !bytes.Equal(messages[0].Data, data) {
		t.Errorf("data mismatch")
	}
	if !upToDate {
		t.Error("should be up to date")
	}

	// Read from tail (should be empty)
	messages, upToDate, err = store.Read("/test", result.Offset)
	if err != nil {
		t.Fatalf("Read from tail failed: %v", err)
	}
	if len(messages) != 0 {
		t.Errorf("expected 0 messages at tail, got %d", len(messages))
	}
	if !upToDate {
		t.Error("should be up to date at tail")
	}
}

func TestFileStore_AppendJSON(t *testing.T) {
	tmpDir, err := os.MkdirTemp("", "filestore-test-*")
	if err != nil {
		t.Fatalf("failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(tmpDir)

	store, err := NewFileStore(FileStoreConfig{DataDir: tmpDir})
	if err != nil {
		t.Fatalf("failed to create store: %v", err)
	}
	defer store.Close()

	// Create JSON stream
	_, _, err = store.Create("/json", CreateOptions{ContentType: "application/json"})
	if err != nil {
		t.Fatalf("Create failed: %v", err)
	}

	// Append array (should be flattened)
	_, err = store.Append("/json", []byte(`[{"id":1},{"id":2}]`), AppendOptions{})
	if err != nil {
		t.Fatalf("Append failed: %v", err)
	}

	// Read back
	messages, _, err := store.Read("/json", ZeroOffset)
	if err != nil {
		t.Fatalf("Read failed: %v", err)
	}
	if len(messages) != 2 {
		t.Errorf("expected 2 messages (flattened array), got %d", len(messages))
	}

	// Format response
	resp, err := store.FormatResponse("/json", messages)
	if err != nil {
		t.Fatalf("FormatResponse failed: %v", err)
	}
	if string(resp) != `[{"id":1},{"id":2}]` {
		t.Errorf("formatted response mismatch: %s", resp)
	}
}

func TestFileStore_Delete(t *testing.T) {
	tmpDir, err := os.MkdirTemp("", "filestore-test-*")
	if err != nil {
		t.Fatalf("failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(tmpDir)

	store, err := NewFileStore(FileStoreConfig{DataDir: tmpDir})
	if err != nil {
		t.Fatalf("failed to create store: %v", err)
	}
	defer store.Close()

	// Create and then delete
	_, _, _ = store.Create("/test", CreateOptions{ContentType: "text/plain"})

	if err := store.Delete("/test"); err != nil {
		t.Fatalf("Delete failed: %v", err)
	}

	if store.Has("/test") {
		t.Error("stream still exists after delete")
	}

	// Delete nonexistent
	err = store.Delete("/nonexistent")
	if err != ErrStreamNotFound {
		t.Errorf("expected ErrStreamNotFound, got %v", err)
	}
}

func TestFileStore_SequenceConflict(t *testing.T) {
	tmpDir, err := os.MkdirTemp("", "filestore-test-*")
	if err != nil {
		t.Fatalf("failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(tmpDir)

	store, err := NewFileStore(FileStoreConfig{DataDir: tmpDir})
	if err != nil {
		t.Fatalf("failed to create store: %v", err)
	}
	defer store.Close()

	_, _, _ = store.Create("/test", CreateOptions{ContentType: "text/plain"})

	// First append with seq
	_, err = store.Append("/test", []byte("a"), AppendOptions{Seq: "seq1"})
	if err != nil {
		t.Fatalf("first append failed: %v", err)
	}

	// Second append with same seq should fail
	_, err = store.Append("/test", []byte("b"), AppendOptions{Seq: "seq1"})
	if err != ErrSequenceConflict {
		t.Errorf("expected ErrSequenceConflict, got %v", err)
	}

	// Append with higher seq should work
	_, err = store.Append("/test", []byte("c"), AppendOptions{Seq: "seq2"})
	if err != nil {
		t.Fatalf("third append failed: %v", err)
	}
}

func TestFileStore_ContentTypeMismatch(t *testing.T) {
	tmpDir, err := os.MkdirTemp("", "filestore-test-*")
	if err != nil {
		t.Fatalf("failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(tmpDir)

	store, err := NewFileStore(FileStoreConfig{DataDir: tmpDir})
	if err != nil {
		t.Fatalf("failed to create store: %v", err)
	}
	defer store.Close()

	_, _, _ = store.Create("/test", CreateOptions{ContentType: "text/plain"})

	// Append with wrong content type
	_, err = store.Append("/test", []byte("data"), AppendOptions{ContentType: "application/json"})
	if err != ErrContentTypeMismatch {
		t.Errorf("expected ErrContentTypeMismatch, got %v", err)
	}
}

func TestFileStore_Persistence(t *testing.T) {
	tmpDir, err := os.MkdirTemp("", "filestore-test-*")
	if err != nil {
		t.Fatalf("failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(tmpDir)

	// Create store and add data
	{
		store, err := NewFileStore(FileStoreConfig{DataDir: tmpDir})
		if err != nil {
			t.Fatalf("failed to create store: %v", err)
		}

		_, _, _ = store.Create("/test", CreateOptions{ContentType: "text/plain"})
		store.Append("/test", []byte("hello"), AppendOptions{})
		store.Close()
	}

	// Reopen and verify
	{
		store, err := NewFileStore(FileStoreConfig{DataDir: tmpDir})
		if err != nil {
			t.Fatalf("failed to reopen store: %v", err)
		}
		defer store.Close()

		if !store.Has("/test") {
			t.Error("stream should exist after reopen")
		}

		messages, _, err := store.Read("/test", ZeroOffset)
		if err != nil {
			t.Fatalf("Read failed: %v", err)
		}
		if len(messages) != 1 {
			t.Errorf("expected 1 message, got %d", len(messages))
		}
		if !bytes.Equal(messages[0].Data, []byte("hello")) {
			t.Error("data mismatch after reopen")
		}
	}
}

func TestRecoverStore_TruncatesCorruptSegmentTail(t *testing.T) {
	tmpDir, err := os.MkdirTemp("", "filestore-test-*")
	if err != nil {
		t.Fatalf("failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(tmpDir)

	var segPath string
	{
		store, err := NewFileStore(FileStoreConfig{DataDir: tmpDir})
		if err != nil {
			t.Fatalf("failed to create store: %v", err)
		}

		if _, _, err := store.Create("/test", CreateOptions{ContentType: "text/plain"}); err != nil {
			t.Fatalf("Create failed: %v", err)
		}
		if _, err := store.Append("/test", []byte("before"), AppendOptions{}); err != nil {
			t.Fatalf("Append failed: %v", err)
		}

		segPath = filepath.Join(tmpDir, "streams", store.dirCache["/test"], SegmentFileName)
		if err := store.Close(); err != nil {
			t.Fatalf("Close failed: %v", err)
		}
	}

	validInfo, err := os.Stat(segPath)
	if err != nil {
		t.Fatalf("failed to stat clean segment: %v", err)
	}
	validSize := validInfo.Size()

	file, err := os.OpenFile(segPath, os.O_APPEND|os.O_WRONLY, 0644)
	if err != nil {
		t.Fatalf("failed to open segment for corruption: %v", err)
	}
	var corruptLen [LengthPrefixSize]byte
	binary.BigEndian.PutUint32(corruptLen[:], MaxMessageSize+1)
	if _, err := file.Write(corruptLen[:]); err != nil {
		file.Close()
		t.Fatalf("failed to append corrupt length: %v", err)
	}
	if err := file.Close(); err != nil {
		t.Fatalf("failed to close corrupted segment: %v", err)
	}

	if err := RecoverStore(tmpDir); err != nil {
		t.Fatalf("RecoverStore failed: %v", err)
	}

	recoveredInfo, err := os.Stat(segPath)
	if err != nil {
		t.Fatalf("failed to stat recovered segment: %v", err)
	}
	if recoveredInfo.Size() != validSize {
		t.Fatalf("expected segment size %d after recovery, got %d", validSize, recoveredInfo.Size())
	}

	store, err := NewFileStore(FileStoreConfig{DataDir: tmpDir})
	if err != nil {
		t.Fatalf("failed to reopen store: %v", err)
	}
	defer store.Close()

	if _, err := store.Append("/test", []byte("after"), AppendOptions{}); err != nil {
		t.Fatalf("Append after recovery failed: %v", err)
	}

	messages, _, err := store.Read("/test", ZeroOffset)
	if err != nil {
		t.Fatalf("Read after recovery failed: %v", err)
	}
	if len(messages) != 2 {
		t.Fatalf("expected 2 messages after recovery append, got %d", len(messages))
	}
	if !bytes.Equal(messages[0].Data, []byte("before")) || !bytes.Equal(messages[1].Data, []byte("after")) {
		t.Fatalf("unexpected messages after recovery: %q, %q", messages[0].Data, messages[1].Data)
	}
}

func TestRecoverStoreWithEvents_ReportsTruncation(t *testing.T) {
	tmpDir, err := os.MkdirTemp("", "filestore-test-*")
	if err != nil {
		t.Fatalf("failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(tmpDir)

	var segPath string
	{
		store, err := NewFileStore(FileStoreConfig{DataDir: tmpDir})
		if err != nil {
			t.Fatalf("failed to create store: %v", err)
		}

		if _, _, err := store.Create("/test", CreateOptions{ContentType: "text/plain"}); err != nil {
			t.Fatalf("Create failed: %v", err)
		}
		if _, err := store.Append("/test", []byte("before"), AppendOptions{}); err != nil {
			t.Fatalf("Append failed: %v", err)
		}

		segPath = filepath.Join(tmpDir, "streams", store.dirCache["/test"], SegmentFileName)
		if err := store.Close(); err != nil {
			t.Fatalf("Close failed: %v", err)
		}
	}

	validInfo, err := os.Stat(segPath)
	if err != nil {
		t.Fatalf("failed to stat clean segment: %v", err)
	}

	file, err := os.OpenFile(segPath, os.O_APPEND|os.O_WRONLY, 0644)
	if err != nil {
		t.Fatalf("failed to open segment for corruption: %v", err)
	}
	corruptTail := []byte{0xff, 0xff, 0xff, 0xff}
	if _, err := file.Write(corruptTail); err != nil {
		file.Close()
		t.Fatalf("failed to append corrupt tail: %v", err)
	}
	if err := file.Close(); err != nil {
		t.Fatalf("failed to close corrupted segment: %v", err)
	}

	var events []RecoveryEvent
	if err := RecoverStoreWithEvents(tmpDir, func(event RecoveryEvent) {
		events = append(events, event)
	}); err != nil {
		t.Fatalf("RecoverStoreWithEvents failed: %v", err)
	}

	if len(events) != 1 {
		t.Fatalf("expected 1 recovery event, got %d", len(events))
	}
	if events[0].StreamPath != "/test" {
		t.Fatalf("expected stream path /test, got %q", events[0].StreamPath)
	}
	if events[0].SegmentPath != segPath {
		t.Fatalf("expected segment path %q, got %q", segPath, events[0].SegmentPath)
	}
	if events[0].OriginalSize != uint64(validInfo.Size()+int64(len(corruptTail))) {
		t.Fatalf("unexpected original size: %d", events[0].OriginalSize)
	}
	if events[0].RecoveredSize != uint64(validInfo.Size()) {
		t.Fatalf("unexpected recovered size: %d", events[0].RecoveredSize)
	}
	if events[0].DiscardedBytes != uint64(len(corruptTail)) {
		t.Fatalf("expected %d discarded bytes, got %d", len(corruptTail), events[0].DiscardedBytes)
	}
}

func TestFileStore_LongPoll(t *testing.T) {
	tmpDir, err := os.MkdirTemp("", "filestore-test-*")
	if err != nil {
		t.Fatalf("failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(tmpDir)

	store, err := NewFileStore(FileStoreConfig{DataDir: tmpDir})
	if err != nil {
		t.Fatalf("failed to create store: %v", err)
	}
	defer store.Close()

	_, _, _ = store.Create("/test", CreateOptions{ContentType: "text/plain"})

	// Start long-poll
	done := make(chan struct{})
	var messages []Message
	var timedOut bool
	go func() {
		messages, timedOut, _, _ = store.WaitForMessages(context.Background(), "/test", ZeroOffset, 5*time.Second)
		close(done)
	}()

	// Wait a bit then append
	time.Sleep(100 * time.Millisecond)
	store.Append("/test", []byte("wakeup"), AppendOptions{})

	// Wait for long-poll to complete
	select {
	case <-done:
		if timedOut {
			t.Error("long-poll should not have timed out")
		}
		if len(messages) != 1 {
			t.Errorf("expected 1 message, got %d", len(messages))
		}
	case <-time.After(2 * time.Second):
		t.Error("long-poll did not complete in time")
	}
}

func TestFileStore_LongPollTimeout(t *testing.T) {
	tmpDir, err := os.MkdirTemp("", "filestore-test-*")
	if err != nil {
		t.Fatalf("failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(tmpDir)

	store, err := NewFileStore(FileStoreConfig{DataDir: tmpDir})
	if err != nil {
		t.Fatalf("failed to create store: %v", err)
	}
	defer store.Close()

	_, _, _ = store.Create("/test", CreateOptions{ContentType: "text/plain"})
	store.Append("/test", []byte("initial"), AppendOptions{})
	offset, _ := store.GetCurrentOffset("/test")

	// Long-poll at tail with short timeout
	messages, timedOut, _, err := store.WaitForMessages(context.Background(), "/test", offset, 100*time.Millisecond)
	if err != nil {
		t.Fatalf("WaitForMessages failed: %v", err)
	}
	if !timedOut {
		t.Error("expected timeout")
	}
	if len(messages) != 0 {
		t.Errorf("expected 0 messages on timeout, got %d", len(messages))
	}
}

func TestFileStore_InitialData(t *testing.T) {
	tmpDir, err := os.MkdirTemp("", "filestore-test-*")
	if err != nil {
		t.Fatalf("failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(tmpDir)

	store, err := NewFileStore(FileStoreConfig{DataDir: tmpDir})
	if err != nil {
		t.Fatalf("failed to create store: %v", err)
	}
	defer store.Close()

	// Create with initial data
	meta, _, err := store.Create("/test", CreateOptions{
		ContentType: "text/plain",
		InitialData: []byte("initial content"),
	})
	if err != nil {
		t.Fatalf("Create failed: %v", err)
	}
	if meta.CurrentOffset.ByteOffset == 0 {
		t.Error("offset should be non-zero with initial data")
	}

	// Read back
	messages, _, err := store.Read("/test", ZeroOffset)
	if err != nil {
		t.Fatalf("Read failed: %v", err)
	}
	if len(messages) != 1 {
		t.Errorf("expected 1 message, got %d", len(messages))
	}
	if !bytes.Equal(messages[0].Data, []byte("initial content")) {
		t.Error("initial data mismatch")
	}
}

func TestFileStore_StreamClosure(t *testing.T) {
	tmpDir, err := os.MkdirTemp("", "filestore-test-*")
	if err != nil {
		t.Fatalf("failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(tmpDir)

	store, err := NewFileStore(FileStoreConfig{DataDir: tmpDir})
	if err != nil {
		t.Fatalf("failed to create store: %v", err)
	}
	defer store.Close()

	// Create stream
	_, _, err = store.Create("/test", CreateOptions{
		ContentType: "text/plain",
	})
	if err != nil {
		t.Fatalf("Create failed: %v", err)
	}

	// Append some data
	_, err = store.Append("/test", []byte("data"), AppendOptions{})
	if err != nil {
		t.Fatalf("Append failed: %v", err)
	}

	// Close the stream
	closeResult, err := store.CloseStream("/test")
	if err != nil {
		t.Fatalf("CloseStream failed: %v", err)
	}
	if closeResult.AlreadyClosed {
		t.Error("stream should not be already closed")
	}

	// Verify stream is closed
	meta, err := store.Get("/test")
	if err != nil {
		t.Fatalf("Get failed: %v", err)
	}
	if !meta.Closed {
		t.Error("stream should be closed")
	}

	// Try to append to closed stream - should fail
	_, err = store.Append("/test", []byte("more data"), AppendOptions{})
	if err != ErrStreamClosed {
		t.Errorf("expected ErrStreamClosed, got: %v", err)
	}

	// Close again (idempotent)
	closeResult, err = store.CloseStream("/test")
	if err != nil {
		t.Fatalf("second CloseStream failed: %v", err)
	}
	if !closeResult.AlreadyClosed {
		t.Error("stream should be already closed")
	}
}

func TestFileStore_CreateClosed(t *testing.T) {
	tmpDir, err := os.MkdirTemp("", "filestore-test-*")
	if err != nil {
		t.Fatalf("failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(tmpDir)

	store, err := NewFileStore(FileStoreConfig{DataDir: tmpDir})
	if err != nil {
		t.Fatalf("failed to create store: %v", err)
	}
	defer store.Close()

	// Create stream in closed state
	meta, _, err := store.Create("/closed", CreateOptions{
		ContentType: "text/plain",
		Closed:      true,
	})
	if err != nil {
		t.Fatalf("Create failed: %v", err)
	}
	if !meta.Closed {
		t.Error("stream should be created closed")
	}

	// Append should fail
	_, err = store.Append("/closed", []byte("data"), AppendOptions{})
	if err != ErrStreamClosed {
		t.Errorf("expected ErrStreamClosed, got: %v", err)
	}
}

func TestFileStore_AppendAndClose(t *testing.T) {
	tmpDir, err := os.MkdirTemp("", "filestore-test-*")
	if err != nil {
		t.Fatalf("failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(tmpDir)

	store, err := NewFileStore(FileStoreConfig{DataDir: tmpDir})
	if err != nil {
		t.Fatalf("failed to create store: %v", err)
	}
	defer store.Close()

	// Create stream
	_, _, err = store.Create("/test", CreateOptions{
		ContentType: "text/plain",
	})
	if err != nil {
		t.Fatalf("Create failed: %v", err)
	}

	// Append with close
	result, err := store.Append("/test", []byte("final"), AppendOptions{
		Close: true,
	})
	if err != nil {
		t.Fatalf("Append with close failed: %v", err)
	}
	if !result.StreamClosed {
		t.Error("StreamClosed should be true")
	}

	// Verify stream is closed
	meta, err := store.Get("/test")
	if err != nil {
		t.Fatalf("Get failed: %v", err)
	}
	if !meta.Closed {
		t.Error("stream should be closed after append with close")
	}

	// Read back data
	messages, _, err := store.Read("/test", ZeroOffset)
	if err != nil {
		t.Fatalf("Read failed: %v", err)
	}
	if len(messages) != 1 {
		t.Errorf("expected 1 message, got %d", len(messages))
	}
	if !bytes.Equal(messages[0].Data, []byte("final")) {
		t.Error("data mismatch")
	}
}
