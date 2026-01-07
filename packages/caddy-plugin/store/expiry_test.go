package store

import (
	"os"
	"testing"
	"time"
)

func TestStreamMetadata_IsExpired_ExpiresAt(t *testing.T) {
	// Stream with ExpiresAt in the past
	pastTime := time.Now().Add(-1 * time.Hour)
	meta := &StreamMetadata{
		Path:      "/test",
		ExpiresAt: &pastTime,
		CreatedAt: time.Now().Add(-2 * time.Hour),
	}
	if !meta.IsExpired() {
		t.Error("stream with past ExpiresAt should be expired")
	}

	// Stream with ExpiresAt in the future
	futureTime := time.Now().Add(1 * time.Hour)
	meta.ExpiresAt = &futureTime
	if meta.IsExpired() {
		t.Error("stream with future ExpiresAt should not be expired")
	}
}

func TestStreamMetadata_IsExpired_TTL(t *testing.T) {
	// Stream with TTL that has passed
	ttl := int64(1) // 1 second
	meta := &StreamMetadata{
		Path:       "/test",
		TTLSeconds: &ttl,
		CreatedAt:  time.Now().Add(-2 * time.Second), // Created 2 seconds ago
	}
	if !meta.IsExpired() {
		t.Error("stream with expired TTL should be expired")
	}

	// Stream with TTL that hasn't passed
	meta.CreatedAt = time.Now() // Just created
	if meta.IsExpired() {
		t.Error("stream with non-expired TTL should not be expired")
	}
}

func TestStreamMetadata_IsExpired_NoExpiry(t *testing.T) {
	// Stream without any expiry
	meta := &StreamMetadata{
		Path:      "/test",
		CreatedAt: time.Now().Add(-24 * time.Hour),
	}
	if meta.IsExpired() {
		t.Error("stream without expiry settings should never expire")
	}
}

func TestMemoryStore_ExpiryOnGet(t *testing.T) {
	store := NewMemoryStore()
	defer store.Close()

	// Create a stream with very short TTL
	ttl := int64(1) // 1 second
	_, _, err := store.Create("/expiring", CreateOptions{
		ContentType: "text/plain",
		TTLSeconds:  &ttl,
	})
	if err != nil {
		t.Fatalf("Create failed: %v", err)
	}

	// Should be accessible immediately
	_, err = store.Get("/expiring")
	if err != nil {
		t.Fatalf("Get failed immediately after create: %v", err)
	}

	// Wait for TTL to expire
	time.Sleep(1100 * time.Millisecond)

	// Should now return not found
	_, err = store.Get("/expiring")
	if err != ErrStreamNotFound {
		t.Errorf("expected ErrStreamNotFound after expiry, got %v", err)
	}
}

func TestMemoryStore_ExpiryOnHas(t *testing.T) {
	store := NewMemoryStore()
	defer store.Close()

	ttl := int64(1)
	store.Create("/expiring", CreateOptions{
		ContentType: "text/plain",
		TTLSeconds:  &ttl,
	})

	if !store.Has("/expiring") {
		t.Error("Has should return true before expiry")
	}

	time.Sleep(1100 * time.Millisecond)

	if store.Has("/expiring") {
		t.Error("Has should return false after expiry")
	}
}

func TestMemoryStore_ExpiryOnAppend(t *testing.T) {
	store := NewMemoryStore()
	defer store.Close()

	ttl := int64(1)
	store.Create("/expiring", CreateOptions{
		ContentType: "text/plain",
		TTLSeconds:  &ttl,
	})

	// Should be able to append immediately
	_, err := store.Append("/expiring", []byte("data"), AppendOptions{})
	if err != nil {
		t.Fatalf("Append failed before expiry: %v", err)
	}

	time.Sleep(1100 * time.Millisecond)

	// Should fail after expiry
	_, err = store.Append("/expiring", []byte("more data"), AppendOptions{})
	if err != ErrStreamNotFound {
		t.Errorf("expected ErrStreamNotFound on append after expiry, got %v", err)
	}
}

func TestMemoryStore_ExpiryOnRead(t *testing.T) {
	store := NewMemoryStore()
	defer store.Close()

	ttl := int64(1)
	store.Create("/expiring", CreateOptions{
		ContentType: "text/plain",
		TTLSeconds:  &ttl,
	})
	store.Append("/expiring", []byte("data"), AppendOptions{})

	// Should be able to read immediately
	_, _, err := store.Read("/expiring", ZeroOffset)
	if err != nil {
		t.Fatalf("Read failed before expiry: %v", err)
	}

	time.Sleep(1100 * time.Millisecond)

	// Should fail after expiry
	_, _, err = store.Read("/expiring", ZeroOffset)
	if err != ErrStreamNotFound {
		t.Errorf("expected ErrStreamNotFound on read after expiry, got %v", err)
	}
}

func TestMemoryStore_ExpiresAtExpiry(t *testing.T) {
	store := NewMemoryStore()
	defer store.Close()

	// Create a stream that expires 1 second from now
	expiresAt := time.Now().Add(1 * time.Second)
	_, _, err := store.Create("/expiring", CreateOptions{
		ContentType: "text/plain",
		ExpiresAt:   &expiresAt,
	})
	if err != nil {
		t.Fatalf("Create failed: %v", err)
	}

	// Should be accessible immediately
	if !store.Has("/expiring") {
		t.Error("stream should exist before expiry")
	}

	time.Sleep(1100 * time.Millisecond)

	// Should be expired
	if store.Has("/expiring") {
		t.Error("stream should not exist after expiry")
	}
}

func TestFileStore_ExpiryOnGet(t *testing.T) {
	tmpDir, err := os.MkdirTemp("", "filestore-expiry-*")
	if err != nil {
		t.Fatalf("failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(tmpDir)

	store, err := NewFileStore(FileStoreConfig{DataDir: tmpDir})
	if err != nil {
		t.Fatalf("failed to create store: %v", err)
	}
	defer store.Close()

	ttl := int64(1)
	_, _, err = store.Create("/expiring", CreateOptions{
		ContentType: "text/plain",
		TTLSeconds:  &ttl,
	})
	if err != nil {
		t.Fatalf("Create failed: %v", err)
	}

	// Should be accessible immediately
	_, err = store.Get("/expiring")
	if err != nil {
		t.Fatalf("Get failed immediately: %v", err)
	}

	time.Sleep(1100 * time.Millisecond)

	// Should return not found after expiry
	_, err = store.Get("/expiring")
	if err != ErrStreamNotFound {
		t.Errorf("expected ErrStreamNotFound after expiry, got %v", err)
	}
}

func TestFileStore_ExpiryOnAppend(t *testing.T) {
	tmpDir, err := os.MkdirTemp("", "filestore-expiry-*")
	if err != nil {
		t.Fatalf("failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(tmpDir)

	store, err := NewFileStore(FileStoreConfig{DataDir: tmpDir})
	if err != nil {
		t.Fatalf("failed to create store: %v", err)
	}
	defer store.Close()

	ttl := int64(1)
	store.Create("/expiring", CreateOptions{
		ContentType: "text/plain",
		TTLSeconds:  &ttl,
	})

	_, err = store.Append("/expiring", []byte("data"), AppendOptions{})
	if err != nil {
		t.Fatalf("Append failed before expiry: %v", err)
	}

	time.Sleep(1100 * time.Millisecond)

	_, err = store.Append("/expiring", []byte("more"), AppendOptions{})
	if err != ErrStreamNotFound {
		t.Errorf("expected ErrStreamNotFound on append after expiry, got %v", err)
	}
}

func TestFileStore_ExpiryOnRead(t *testing.T) {
	tmpDir, err := os.MkdirTemp("", "filestore-expiry-*")
	if err != nil {
		t.Fatalf("failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(tmpDir)

	store, err := NewFileStore(FileStoreConfig{DataDir: tmpDir})
	if err != nil {
		t.Fatalf("failed to create store: %v", err)
	}
	defer store.Close()

	ttl := int64(1)
	store.Create("/expiring", CreateOptions{
		ContentType: "text/plain",
		TTLSeconds:  &ttl,
	})
	store.Append("/expiring", []byte("data"), AppendOptions{})

	_, _, err = store.Read("/expiring", ZeroOffset)
	if err != nil {
		t.Fatalf("Read failed before expiry: %v", err)
	}

	time.Sleep(1100 * time.Millisecond)

	_, _, err = store.Read("/expiring", ZeroOffset)
	if err != ErrStreamNotFound {
		t.Errorf("expected ErrStreamNotFound on read after expiry, got %v", err)
	}
}

func TestFileStore_BackgroundCleanup(t *testing.T) {
	tmpDir, err := os.MkdirTemp("", "filestore-cleanup-*")
	if err != nil {
		t.Fatalf("failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(tmpDir)

	// Create store with very short cleanup interval
	store, err := NewFileStore(FileStoreConfig{
		DataDir:         tmpDir,
		CleanupInterval: 500 * time.Millisecond,
	})
	if err != nil {
		t.Fatalf("failed to create store: %v", err)
	}
	defer store.Close()

	// Create a stream with very short TTL
	ttl := int64(1)
	store.Create("/expiring", CreateOptions{
		ContentType: "text/plain",
		TTLSeconds:  &ttl,
	})
	store.Append("/expiring", []byte("data"), AppendOptions{})

	// Create a non-expiring stream
	store.Create("/permanent", CreateOptions{
		ContentType: "text/plain",
	})
	store.Append("/permanent", []byte("data"), AppendOptions{})

	// Both should exist
	if !store.Has("/expiring") {
		t.Error("expiring stream should exist before expiry")
	}
	if !store.Has("/permanent") {
		t.Error("permanent stream should exist")
	}

	// Wait for TTL to expire and cleanup to run
	time.Sleep(1600 * time.Millisecond)

	// Expiring stream should be cleaned up
	// Note: Has() returns false for expired streams even without cleanup,
	// but the cleanup should have removed it from the underlying storage
	if store.Has("/expiring") {
		t.Error("expiring stream should not exist after cleanup")
	}

	// Permanent stream should still exist
	if !store.Has("/permanent") {
		t.Error("permanent stream should still exist after cleanup")
	}

	// Verify the expiring stream was actually removed from cache
	store.metaCacheMu.RLock()
	_, inCache := store.metaCache["/expiring"]
	store.metaCacheMu.RUnlock()
	if inCache {
		t.Error("expired stream should have been removed from cache by cleanup")
	}
}
