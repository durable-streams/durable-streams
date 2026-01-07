package store

import (
	"os"
	"path/filepath"
	"testing"
)

func TestFilePool(t *testing.T) {
	tmpDir, err := os.MkdirTemp("", "filepool-test-*")
	if err != nil {
		t.Fatalf("failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(tmpDir)

	pool := NewFilePool(3)
	defer pool.Close()

	// Get a writer
	path1 := filepath.Join(tmpDir, "file1.dat")
	f1, err := pool.GetWriter(path1)
	if err != nil {
		t.Fatalf("GetWriter failed: %v", err)
	}
	if f1 == nil {
		t.Fatal("GetWriter returned nil")
	}

	// Write something
	if _, err := f1.Write([]byte("hello")); err != nil {
		t.Fatalf("Write failed: %v", err)
	}

	// Get the same file again (should return cached)
	f1Again, err := pool.GetWriter(path1)
	if err != nil {
		t.Fatalf("GetWriter again failed: %v", err)
	}
	if f1Again != f1 {
		t.Error("GetWriter should return same file handle")
	}

	// Size should be 1
	if pool.Size() != 1 {
		t.Errorf("Size should be 1, got %d", pool.Size())
	}
}

func TestFilePoolEviction(t *testing.T) {
	tmpDir, err := os.MkdirTemp("", "filepool-test-*")
	if err != nil {
		t.Fatalf("failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(tmpDir)

	// Pool with max size 2
	pool := NewFilePool(2)
	defer pool.Close()

	// Open 3 files
	paths := make([]string, 3)
	for i := 0; i < 3; i++ {
		paths[i] = filepath.Join(tmpDir, "file"+string(rune('a'+i))+".dat")
		if _, err := pool.GetWriter(paths[i]); err != nil {
			t.Fatalf("GetWriter failed for %s: %v", paths[i], err)
		}
	}

	// Size should be 2 (first was evicted)
	if pool.Size() != 2 {
		t.Errorf("Size should be 2 after eviction, got %d", pool.Size())
	}

	// First file should have been evicted
	pool.mu.Lock()
	_, firstExists := pool.files[paths[0]]
	pool.mu.Unlock()
	if firstExists {
		t.Error("First file should have been evicted")
	}
}

func TestFilePoolSync(t *testing.T) {
	tmpDir, err := os.MkdirTemp("", "filepool-test-*")
	if err != nil {
		t.Fatalf("failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(tmpDir)

	pool := NewFilePool(10)
	defer pool.Close()

	path := filepath.Join(tmpDir, "sync-test.dat")
	f, err := pool.GetWriter(path)
	if err != nil {
		t.Fatalf("GetWriter failed: %v", err)
	}

	f.Write([]byte("test data"))

	// Sync should not error
	if err := pool.Sync(path); err != nil {
		t.Errorf("Sync failed: %v", err)
	}

	// SyncAll should not error
	if err := pool.SyncAll(); err != nil {
		t.Errorf("SyncAll failed: %v", err)
	}
}

func TestFilePoolRemove(t *testing.T) {
	tmpDir, err := os.MkdirTemp("", "filepool-test-*")
	if err != nil {
		t.Fatalf("failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(tmpDir)

	pool := NewFilePool(10)
	defer pool.Close()

	path := filepath.Join(tmpDir, "remove-test.dat")
	if _, err := pool.GetWriter(path); err != nil {
		t.Fatalf("GetWriter failed: %v", err)
	}

	if pool.Size() != 1 {
		t.Error("Size should be 1 before remove")
	}

	if err := pool.Remove(path); err != nil {
		t.Errorf("Remove failed: %v", err)
	}

	if pool.Size() != 0 {
		t.Error("Size should be 0 after remove")
	}

	// Remove nonexistent should not error
	if err := pool.Remove("/nonexistent"); err != nil {
		t.Errorf("Remove nonexistent should not error: %v", err)
	}
}

func TestReaderPool(t *testing.T) {
	tmpDir, err := os.MkdirTemp("", "readerpool-test-*")
	if err != nil {
		t.Fatalf("failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(tmpDir)

	// Create a test file
	path := filepath.Join(tmpDir, "test.dat")
	if err := os.WriteFile(path, []byte("hello"), 0644); err != nil {
		t.Fatalf("failed to create test file: %v", err)
	}

	pool := NewReaderPool(10)
	defer pool.Close()

	// Get reader
	f, err := pool.GetReader(path)
	if err != nil {
		t.Fatalf("GetReader failed: %v", err)
	}

	// Read
	buf := make([]byte, 5)
	n, err := f.Read(buf)
	if err != nil {
		t.Fatalf("Read failed: %v", err)
	}
	if n != 5 || string(buf) != "hello" {
		t.Errorf("unexpected read result: %q", string(buf[:n]))
	}

	// Get again should return same handle
	f2, err := pool.GetReader(path)
	if err != nil {
		t.Fatalf("GetReader again failed: %v", err)
	}
	if f2 != f {
		t.Error("should return same file handle")
	}
}

func TestReaderPoolEviction(t *testing.T) {
	tmpDir, err := os.MkdirTemp("", "readerpool-test-*")
	if err != nil {
		t.Fatalf("failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(tmpDir)

	// Create test files
	for i := 0; i < 3; i++ {
		path := filepath.Join(tmpDir, "file"+string(rune('a'+i))+".dat")
		os.WriteFile(path, []byte("data"), 0644)
	}

	pool := NewReaderPool(2)
	defer pool.Close()

	// Open 3 files
	for i := 0; i < 3; i++ {
		path := filepath.Join(tmpDir, "file"+string(rune('a'+i))+".dat")
		if _, err := pool.GetReader(path); err != nil {
			t.Fatalf("GetReader failed: %v", err)
		}
	}

	// Should have evicted first file
	pool.mu.Lock()
	_, exists := pool.files[filepath.Join(tmpDir, "filea.dat")]
	pool.mu.Unlock()
	if exists {
		t.Error("first file should have been evicted")
	}
}
