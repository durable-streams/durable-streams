package store

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestBboltMetadataStore_CreateAndGet(t *testing.T) {
	// Create temp directory
	tmpDir, err := os.MkdirTemp("", "bbolt-test-*")
	if err != nil {
		t.Fatalf("failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(tmpDir)

	dbPath := filepath.Join(tmpDir, "metadata.bbolt")

	// Create store
	store, err := NewBboltMetadataStore(dbPath)
	if err != nil {
		t.Fatalf("failed to create store: %v", err)
	}
	defer store.Close()

	// Test Put and Get
	now := time.Now()
	ttl := int64(3600)
	expiresAt := now.Add(time.Hour)
	meta := &StreamMetadata{
		Path:          "/test/stream",
		ContentType:   "application/json",
		CurrentOffset: Offset{ReadSeq: 0, ByteOffset: 100},
		LastSeq:       "seq123",
		TTLSeconds:    &ttl,
		ExpiresAt:     &expiresAt,
		CreatedAt:     now,
	}

	err = store.Put(meta, "test~1234567890~abc")
	if err != nil {
		t.Fatalf("failed to put metadata: %v", err)
	}

	// Get it back
	gotMeta, dirName, err := store.Get("/test/stream")
	if err != nil {
		t.Fatalf("failed to get metadata: %v", err)
	}

	if gotMeta.Path != meta.Path {
		t.Errorf("path mismatch: got %q, want %q", gotMeta.Path, meta.Path)
	}
	if gotMeta.ContentType != meta.ContentType {
		t.Errorf("content type mismatch: got %q, want %q", gotMeta.ContentType, meta.ContentType)
	}
	if !gotMeta.CurrentOffset.Equal(meta.CurrentOffset) {
		t.Errorf("offset mismatch: got %v, want %v", gotMeta.CurrentOffset, meta.CurrentOffset)
	}
	if gotMeta.LastSeq != meta.LastSeq {
		t.Errorf("last seq mismatch: got %q, want %q", gotMeta.LastSeq, meta.LastSeq)
	}
	if gotMeta.TTLSeconds == nil || *gotMeta.TTLSeconds != ttl {
		t.Errorf("TTL mismatch: got %v, want %d", gotMeta.TTLSeconds, ttl)
	}
	if dirName != "test~1234567890~abc" {
		t.Errorf("directory name mismatch: got %q, want %q", dirName, "test~1234567890~abc")
	}
}

func TestBboltMetadataStore_Has(t *testing.T) {
	tmpDir, err := os.MkdirTemp("", "bbolt-test-*")
	if err != nil {
		t.Fatalf("failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(tmpDir)

	dbPath := filepath.Join(tmpDir, "metadata.bbolt")
	store, err := NewBboltMetadataStore(dbPath)
	if err != nil {
		t.Fatalf("failed to create store: %v", err)
	}
	defer store.Close()

	// Should not exist initially
	if store.Has("/nonexistent") {
		t.Error("Has returned true for nonexistent stream")
	}

	// Put a stream
	meta := &StreamMetadata{
		Path:          "/test/stream",
		ContentType:   "text/plain",
		CurrentOffset: ZeroOffset,
		CreatedAt:     time.Now(),
	}
	if err := store.Put(meta, "dir1"); err != nil {
		t.Fatalf("failed to put: %v", err)
	}

	// Should exist now
	if !store.Has("/test/stream") {
		t.Error("Has returned false for existing stream")
	}
}

func TestBboltMetadataStore_Delete(t *testing.T) {
	tmpDir, err := os.MkdirTemp("", "bbolt-test-*")
	if err != nil {
		t.Fatalf("failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(tmpDir)

	dbPath := filepath.Join(tmpDir, "metadata.bbolt")
	store, err := NewBboltMetadataStore(dbPath)
	if err != nil {
		t.Fatalf("failed to create store: %v", err)
	}
	defer store.Close()

	// Put a stream
	meta := &StreamMetadata{
		Path:          "/test/stream",
		ContentType:   "text/plain",
		CurrentOffset: ZeroOffset,
		CreatedAt:     time.Now(),
	}
	if err := store.Put(meta, "dir1"); err != nil {
		t.Fatalf("failed to put: %v", err)
	}

	// Delete it
	if err := store.Delete("/test/stream"); err != nil {
		t.Fatalf("failed to delete: %v", err)
	}

	// Should not exist
	if store.Has("/test/stream") {
		t.Error("stream still exists after delete")
	}

	// Delete nonexistent should error
	err = store.Delete("/nonexistent")
	if err != ErrStreamNotFound {
		t.Errorf("expected ErrStreamNotFound, got %v", err)
	}
}

func TestBboltMetadataStore_UpdateOffset(t *testing.T) {
	tmpDir, err := os.MkdirTemp("", "bbolt-test-*")
	if err != nil {
		t.Fatalf("failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(tmpDir)

	dbPath := filepath.Join(tmpDir, "metadata.bbolt")
	store, err := NewBboltMetadataStore(dbPath)
	if err != nil {
		t.Fatalf("failed to create store: %v", err)
	}
	defer store.Close()

	// Put a stream
	meta := &StreamMetadata{
		Path:          "/test/stream",
		ContentType:   "text/plain",
		CurrentOffset: ZeroOffset,
		CreatedAt:     time.Now(),
	}
	if err := store.Put(meta, "dir1"); err != nil {
		t.Fatalf("failed to put: %v", err)
	}

	// Update offset
	newOffset := Offset{ReadSeq: 0, ByteOffset: 500}
	if err := store.UpdateOffset("/test/stream", newOffset, "newseq"); err != nil {
		t.Fatalf("failed to update offset: %v", err)
	}

	// Verify
	gotMeta, _, err := store.Get("/test/stream")
	if err != nil {
		t.Fatalf("failed to get: %v", err)
	}
	if !gotMeta.CurrentOffset.Equal(newOffset) {
		t.Errorf("offset not updated: got %v, want %v", gotMeta.CurrentOffset, newOffset)
	}
	if gotMeta.LastSeq != "newseq" {
		t.Errorf("lastSeq not updated: got %q, want %q", gotMeta.LastSeq, "newseq")
	}

	// Update nonexistent
	err = store.UpdateOffset("/nonexistent", newOffset, "")
	if err != ErrStreamNotFound {
		t.Errorf("expected ErrStreamNotFound, got %v", err)
	}
}

func TestBboltMetadataStore_List(t *testing.T) {
	tmpDir, err := os.MkdirTemp("", "bbolt-test-*")
	if err != nil {
		t.Fatalf("failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(tmpDir)

	dbPath := filepath.Join(tmpDir, "metadata.bbolt")
	store, err := NewBboltMetadataStore(dbPath)
	if err != nil {
		t.Fatalf("failed to create store: %v", err)
	}
	defer store.Close()

	// Empty list
	paths, err := store.List()
	if err != nil {
		t.Fatalf("failed to list: %v", err)
	}
	if len(paths) != 0 {
		t.Errorf("expected empty list, got %v", paths)
	}

	// Add some streams
	for _, path := range []string{"/stream/a", "/stream/b", "/stream/c"} {
		meta := &StreamMetadata{
			Path:          path,
			ContentType:   "text/plain",
			CurrentOffset: ZeroOffset,
			CreatedAt:     time.Now(),
		}
		if err := store.Put(meta, "dir"); err != nil {
			t.Fatalf("failed to put %s: %v", path, err)
		}
	}

	// List again
	paths, err = store.List()
	if err != nil {
		t.Fatalf("failed to list: %v", err)
	}
	if len(paths) != 3 {
		t.Errorf("expected 3 paths, got %d", len(paths))
	}
}

func TestBboltMetadataStore_ForEach(t *testing.T) {
	tmpDir, err := os.MkdirTemp("", "bbolt-test-*")
	if err != nil {
		t.Fatalf("failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(tmpDir)

	dbPath := filepath.Join(tmpDir, "metadata.bbolt")
	store, err := NewBboltMetadataStore(dbPath)
	if err != nil {
		t.Fatalf("failed to create store: %v", err)
	}
	defer store.Close()

	// Add streams
	for i, path := range []string{"/stream/a", "/stream/b"} {
		meta := &StreamMetadata{
			Path:          path,
			ContentType:   "application/json",
			CurrentOffset: Offset{ReadSeq: 0, ByteOffset: uint64(i * 100)},
			CreatedAt:     time.Now(),
		}
		if err := store.Put(meta, "dir"+path); err != nil {
			t.Fatalf("failed to put %s: %v", path, err)
		}
	}

	// ForEach
	count := 0
	err = store.ForEach(func(meta *StreamMetadata, dirName string) error {
		count++
		if meta.ContentType != "application/json" {
			t.Errorf("wrong content type: %q", meta.ContentType)
		}
		return nil
	})
	if err != nil {
		t.Fatalf("ForEach failed: %v", err)
	}
	if count != 2 {
		t.Errorf("expected 2 iterations, got %d", count)
	}
}

func TestBboltMetadataStore_Persistence(t *testing.T) {
	tmpDir, err := os.MkdirTemp("", "bbolt-test-*")
	if err != nil {
		t.Fatalf("failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(tmpDir)

	dbPath := filepath.Join(tmpDir, "metadata.bbolt")

	// Create store and add data
	{
		store, err := NewBboltMetadataStore(dbPath)
		if err != nil {
			t.Fatalf("failed to create store: %v", err)
		}

		meta := &StreamMetadata{
			Path:          "/persistent",
			ContentType:   "text/plain",
			CurrentOffset: Offset{ReadSeq: 1, ByteOffset: 999},
			CreatedAt:     time.Now(),
		}
		if err := store.Put(meta, "persistent-dir"); err != nil {
			t.Fatalf("failed to put: %v", err)
		}

		if err := store.Close(); err != nil {
			t.Fatalf("failed to close: %v", err)
		}
	}

	// Reopen and verify
	{
		store, err := NewBboltMetadataStore(dbPath)
		if err != nil {
			t.Fatalf("failed to reopen store: %v", err)
		}
		defer store.Close()

		meta, dirName, err := store.Get("/persistent")
		if err != nil {
			t.Fatalf("failed to get: %v", err)
		}
		if meta.Path != "/persistent" {
			t.Errorf("path mismatch: %q", meta.Path)
		}
		if meta.CurrentOffset.ByteOffset != 999 {
			t.Errorf("offset not persisted: %v", meta.CurrentOffset)
		}
		if dirName != "persistent-dir" {
			t.Errorf("dir name not persisted: %q", dirName)
		}
	}
}

func TestBboltMetadataStore_GetNotFound(t *testing.T) {
	tmpDir, err := os.MkdirTemp("", "bbolt-test-*")
	if err != nil {
		t.Fatalf("failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(tmpDir)

	dbPath := filepath.Join(tmpDir, "metadata.bbolt")
	store, err := NewBboltMetadataStore(dbPath)
	if err != nil {
		t.Fatalf("failed to create store: %v", err)
	}
	defer store.Close()

	_, _, err = store.Get("/nonexistent")
	if err != ErrStreamNotFound {
		t.Errorf("expected ErrStreamNotFound, got %v", err)
	}
}
