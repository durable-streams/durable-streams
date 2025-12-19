package store

import (
	"encoding/json"
	"fmt"
	"os"
	"runtime"
	"sync"
	"time"

	"github.com/PowerDNS/lmdb-go/lmdb"
)

// LMDBMetadataStore stores stream metadata in LMDB
type LMDBMetadataStore struct {
	env    *lmdb.Env
	dbi    lmdb.DBI
	mu     sync.RWMutex
	path   string
	closed bool
}

// lmdbMetadata is the serialized form of StreamMetadata
type lmdbMetadata struct {
	Path          string `json:"path"`
	ContentType   string `json:"content_type"`
	CurrentOffset string `json:"current_offset"` // Offset as string for easy serialization
	LastSeq       string `json:"last_seq"`
	TTLSeconds    *int64 `json:"ttl_seconds,omitempty"`
	ExpiresAt     *int64 `json:"expires_at,omitempty"` // Unix timestamp
	CreatedAt     int64  `json:"created_at"`           // Unix timestamp
	DirectoryName string `json:"directory_name"`
}

// NewLMDBMetadataStore creates a new LMDB-backed metadata store
func NewLMDBMetadataStore(dataDir string) (*LMDBMetadataStore, error) {
	// Create data directory if it doesn't exist
	if err := os.MkdirAll(dataDir, 0755); err != nil {
		return nil, fmt.Errorf("failed to create data directory: %w", err)
	}

	// Create LMDB environment
	env, err := lmdb.NewEnv()
	if err != nil {
		return nil, fmt.Errorf("failed to create LMDB environment: %w", err)
	}

	// Set map size (1GB default, can be adjusted)
	if err := env.SetMapSize(1 << 30); err != nil {
		env.Close()
		return nil, fmt.Errorf("failed to set map size: %w", err)
	}

	// Set max databases to 1 (we only need one named DB)
	if err := env.SetMaxDBs(1); err != nil {
		env.Close()
		return nil, fmt.Errorf("failed to set max dbs: %w", err)
	}

	// Open the environment
	// Note: Without NoSubdir, LMDB creates data.mdb and lock.mdb inside the directory
	if err := env.Open(dataDir, 0, 0755); err != nil {
		env.Close()
		return nil, fmt.Errorf("failed to open LMDB environment: %w", err)
	}

	// Open/create the metadata database
	var dbi lmdb.DBI
	err = env.Update(func(txn *lmdb.Txn) error {
		var err error
		dbi, err = txn.OpenDBI("metadata", lmdb.Create)
		return err
	})
	if err != nil {
		env.Close()
		return nil, fmt.Errorf("failed to open metadata database: %w", err)
	}

	return &LMDBMetadataStore{
		env:  env,
		dbi:  dbi,
		path: dataDir,
	}, nil
}

// Put stores metadata for a stream
func (s *LMDBMetadataStore) Put(meta *StreamMetadata, directoryName string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.closed {
		return fmt.Errorf("store is closed")
	}

	// Convert to serializable form
	lm := lmdbMetadata{
		Path:          meta.Path,
		ContentType:   meta.ContentType,
		CurrentOffset: meta.CurrentOffset.String(),
		LastSeq:       meta.LastSeq,
		TTLSeconds:    meta.TTLSeconds,
		CreatedAt:     meta.CreatedAt.Unix(),
		DirectoryName: directoryName,
	}
	if meta.ExpiresAt != nil {
		ts := meta.ExpiresAt.Unix()
		lm.ExpiresAt = &ts
	}

	data, err := json.Marshal(lm)
	if err != nil {
		return fmt.Errorf("failed to marshal metadata: %w", err)
	}

	// LMDB write transactions must be locked to OS thread
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()

	return s.env.Update(func(txn *lmdb.Txn) error {
		return txn.Put(s.dbi, []byte(meta.Path), data, 0)
	})
}

// Get retrieves metadata for a stream
func (s *LMDBMetadataStore) Get(path string) (*StreamMetadata, string, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	if s.closed {
		return nil, "", fmt.Errorf("store is closed")
	}

	var meta *StreamMetadata
	var directoryName string

	err := s.env.View(func(txn *lmdb.Txn) error {
		data, err := txn.Get(s.dbi, []byte(path))
		if lmdb.IsNotFound(err) {
			return ErrStreamNotFound
		}
		if err != nil {
			return err
		}

		// Make a copy of the data since it's only valid during transaction
		dataCopy := make([]byte, len(data))
		copy(dataCopy, data)

		var lm lmdbMetadata
		if err := json.Unmarshal(dataCopy, &lm); err != nil {
			return fmt.Errorf("failed to unmarshal metadata: %w", err)
		}

		offset, err := ParseOffset(lm.CurrentOffset)
		if err != nil {
			return fmt.Errorf("failed to parse offset: %w", err)
		}

		meta = &StreamMetadata{
			Path:          lm.Path,
			ContentType:   lm.ContentType,
			CurrentOffset: offset,
			LastSeq:       lm.LastSeq,
			TTLSeconds:    lm.TTLSeconds,
		}

		if lm.ExpiresAt != nil {
			t := timeFromUnix(*lm.ExpiresAt)
			meta.ExpiresAt = &t
		}
		meta.CreatedAt = timeFromUnix(lm.CreatedAt)
		directoryName = lm.DirectoryName

		return nil
	})

	if err != nil {
		return nil, "", err
	}
	return meta, directoryName, nil
}

// Has checks if a stream exists
func (s *LMDBMetadataStore) Has(path string) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()

	if s.closed {
		return false
	}

	exists := false
	s.env.View(func(txn *lmdb.Txn) error {
		_, err := txn.Get(s.dbi, []byte(path))
		exists = err == nil
		return nil
	})
	return exists
}

// Delete removes metadata for a stream
func (s *LMDBMetadataStore) Delete(path string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.closed {
		return fmt.Errorf("store is closed")
	}

	// LMDB write transactions must be locked to OS thread
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()

	return s.env.Update(func(txn *lmdb.Txn) error {
		err := txn.Del(s.dbi, []byte(path), nil)
		if lmdb.IsNotFound(err) {
			return ErrStreamNotFound
		}
		return err
	})
}

// UpdateOffset updates only the offset for a stream
func (s *LMDBMetadataStore) UpdateOffset(path string, offset Offset, lastSeq string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.closed {
		return fmt.Errorf("store is closed")
	}

	// LMDB write transactions must be locked to OS thread
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()

	return s.env.Update(func(txn *lmdb.Txn) error {
		// Read existing
		data, err := txn.Get(s.dbi, []byte(path))
		if lmdb.IsNotFound(err) {
			return ErrStreamNotFound
		}
		if err != nil {
			return err
		}

		// Make a copy
		dataCopy := make([]byte, len(data))
		copy(dataCopy, data)

		var lm lmdbMetadata
		if err := json.Unmarshal(dataCopy, &lm); err != nil {
			return err
		}

		// Update offset and seq
		lm.CurrentOffset = offset.String()
		if lastSeq != "" {
			lm.LastSeq = lastSeq
		}

		// Write back
		newData, err := json.Marshal(lm)
		if err != nil {
			return err
		}

		return txn.Put(s.dbi, []byte(path), newData, 0)
	})
}

// List returns all stream paths
func (s *LMDBMetadataStore) List() ([]string, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	if s.closed {
		return nil, fmt.Errorf("store is closed")
	}

	var paths []string
	err := s.env.View(func(txn *lmdb.Txn) error {
		cursor, err := txn.OpenCursor(s.dbi)
		if err != nil {
			return err
		}
		defer cursor.Close()

		for {
			key, _, err := cursor.Get(nil, nil, lmdb.Next)
			if lmdb.IsNotFound(err) {
				break
			}
			if err != nil {
				return err
			}
			// Make a copy of the key
			pathCopy := make([]byte, len(key))
			copy(pathCopy, key)
			paths = append(paths, string(pathCopy))
		}
		return nil
	})

	return paths, err
}

// ForEach iterates over all streams
func (s *LMDBMetadataStore) ForEach(fn func(meta *StreamMetadata, directoryName string) error) error {
	s.mu.RLock()
	defer s.mu.RUnlock()

	if s.closed {
		return fmt.Errorf("store is closed")
	}

	return s.env.View(func(txn *lmdb.Txn) error {
		cursor, err := txn.OpenCursor(s.dbi)
		if err != nil {
			return err
		}
		defer cursor.Close()

		for {
			_, data, err := cursor.Get(nil, nil, lmdb.Next)
			if lmdb.IsNotFound(err) {
				break
			}
			if err != nil {
				return err
			}

			// Make a copy
			dataCopy := make([]byte, len(data))
			copy(dataCopy, data)

			var lm lmdbMetadata
			if err := json.Unmarshal(dataCopy, &lm); err != nil {
				return err
			}

			offset, err := ParseOffset(lm.CurrentOffset)
			if err != nil {
				return err
			}

			meta := &StreamMetadata{
				Path:          lm.Path,
				ContentType:   lm.ContentType,
				CurrentOffset: offset,
				LastSeq:       lm.LastSeq,
				TTLSeconds:    lm.TTLSeconds,
			}
			if lm.ExpiresAt != nil {
				t := timeFromUnix(*lm.ExpiresAt)
				meta.ExpiresAt = &t
			}
			meta.CreatedAt = timeFromUnix(lm.CreatedAt)

			if err := fn(meta, lm.DirectoryName); err != nil {
				return err
			}
		}
		return nil
	})
}

// Close closes the LMDB environment
func (s *LMDBMetadataStore) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.closed {
		return nil
	}
	s.closed = true
	return s.env.Close()
}

// Sync forces a sync of the LMDB database to disk
func (s *LMDBMetadataStore) Sync() error {
	s.mu.RLock()
	defer s.mu.RUnlock()

	if s.closed {
		return fmt.Errorf("store is closed")
	}

	return s.env.Sync(true)
}

// Path returns the path to the LMDB database
func (s *LMDBMetadataStore) Path() string {
	return s.path
}

// timeFromUnix converts a Unix timestamp to time.Time
func timeFromUnix(ts int64) (t time.Time) {
	return time.Unix(ts, 0)
}
