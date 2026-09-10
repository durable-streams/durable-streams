package store

import (
	"errors"
	"sync"
	"testing"
	"time"
)

func auditStores(t *testing.T, fn func(t *testing.T, s Store)) {
	t.Helper()
	t.Run("memory", func(t *testing.T) { fn(t, NewMemoryStore()) })
	t.Run("file", func(t *testing.T) {
		s, err := NewFileStore(FileStoreConfig{DataDir: t.TempDir()})
		if err != nil {
			t.Fatal(err)
		}
		defer s.Close()
		fn(t, s)
	})
}

func TestConcurrentEquivalentForkCreates(t *testing.T) {
	auditStores(t, func(t *testing.T, s Store) {
		if _, _, err := s.Create("/parent", CreateOptions{ContentType: "text/plain", InitialData: []byte("old")}); err != nil {
			t.Fatal(err)
		}
		start := make(chan struct{})
		var wg sync.WaitGroup
		errs := make(chan error, 16)
		created := make(chan bool, 16)
		for i := 0; i < 16; i++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				<-start
				_, c, err := s.Create("/child", CreateOptions{ForkedFrom: "/parent", ContentType: "text/plain"})
				errs <- err
				created <- c
			}()
		}
		close(start)
		wg.Wait()
		close(errs)
		close(created)
		for err := range errs {
			if err != nil {
				t.Errorf("create: %v", err)
			}
		}
		n := 0
		for c := range created {
			if c {
				n++
			}
		}
		if n != 1 {
			t.Fatalf("new creates=%d, want 1", n)
		}
		if err := s.Delete("/parent"); err != nil {
			t.Fatal(err)
		}
		msgs, _, err := s.Read("/child", ZeroOffset)
		if err != nil || len(msgs) != 1 || string(msgs[0].Data) != "old" {
			t.Fatalf("inherited read: %q, %v", messagesBytes(msgs), err)
		}
	})
}

func TestConcurrentMixedContentTypeForkCreatesRejected(t *testing.T) {
	auditStores(t, func(t *testing.T, s Store) {
		_, _, _ = s.Create("/parent", CreateOptions{ContentType: "text/plain"})
		start := make(chan struct{})
		errs := make(chan error, 8)
		var wg sync.WaitGroup
		for i := 0; i < 8; i++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				<-start
				_, _, err := s.Create("/child", CreateOptions{ForkedFrom: "/parent", ContentType: "application/json"})
				errs <- err
			}()
		}
		close(start)
		wg.Wait()
		close(errs)
		for err := range errs {
			if !errors.Is(err, ErrContentTypeMismatch) {
				t.Errorf("got %v", err)
			}
		}
	})
}

func TestExpiringParentKeepsForkAndCascades(t *testing.T) {
	auditStores(t, func(t *testing.T, s Store) {
		expires := time.Now().Add(40 * time.Millisecond)
		childExpires := time.Now().Add(time.Hour)
		_, _, _ = s.Create("/parent", CreateOptions{ContentType: "text/plain", InitialData: []byte("old"), ExpiresAt: &expires})
		_, _, err := s.Create("/child", CreateOptions{ForkedFrom: "/parent", ContentType: "text/plain", ExpiresAt: &childExpires})
		if err != nil {
			t.Fatal(err)
		}
		time.Sleep(60 * time.Millisecond)
		switch x := s.(type) {
		case *FileStore:
			x.cleanupExpiredStreams()
		case *MemoryStore:
			_, _, _ = x.Create("/parent", CreateOptions{ContentType: "text/plain"})
		}
		msgs, _, err := s.Read("/child", ZeroOffset)
		if err != nil || string(messagesBytes(msgs)) != "old" {
			t.Fatalf("child lost inheritance: %q %v", messagesBytes(msgs), err)
		}
		if _, _, err := s.Create("/parent", CreateOptions{ContentType: "text/plain"}); !errors.Is(err, ErrStreamExists) {
			t.Fatalf("recreate while pinned: %v", err)
		}
		if err := s.Delete("/child"); err != nil {
			t.Fatal(err)
		}
		if _, created, err := s.Create("/parent", CreateOptions{ContentType: "text/plain"}); err != nil || !created {
			t.Fatalf("recreate after cascade: created=%v err=%v", created, err)
		}
	})
}

func messagesBytes(ms []Message) []byte {
	var b []byte
	for _, m := range ms {
		b = append(b, m.Data...)
	}
	return b
}

func TestFileStoreRestartReconcilesForkRefCounts(t *testing.T) {
	t.Run("acquired edge without child", func(t *testing.T) {
		dir := t.TempDir()
		s, err := NewFileStore(FileStoreConfig{DataDir: dir})
		if err != nil {
			t.Fatal(err)
		}
		_, _, _ = s.Create("/parent", CreateOptions{ContentType: "text/plain"})
		if err := s.metaStore.IncrementRefCount("/parent"); err != nil {
			t.Fatal(err)
		}
		if err := s.Close(); err != nil {
			t.Fatal(err)
		}
		s, err = NewFileStore(FileStoreConfig{DataDir: dir})
		if err != nil {
			t.Fatal(err)
		}
		defer s.Close()
		m, _ := s.Get("/parent")
		if m.RefCount != 0 {
			t.Fatalf("leaked refcount after restart: %d", m.RefCount)
		}
	})

	t.Run("committed child without acquired edge", func(t *testing.T) {
		dir := t.TempDir()
		s, err := NewFileStore(FileStoreConfig{DataDir: dir})
		if err != nil {
			t.Fatal(err)
		}
		_, _, _ = s.Create("/parent", CreateOptions{ContentType: "text/plain", InitialData: []byte("old")})
		_, _, _ = s.Create("/child", CreateOptions{ForkedFrom: "/parent", ContentType: "text/plain"})
		if _, _, err := s.metaStore.DecrementRefCount("/parent"); err != nil {
			t.Fatal(err)
		}
		if err := s.Close(); err != nil {
			t.Fatal(err)
		}
		s, err = NewFileStore(FileStoreConfig{DataDir: dir})
		if err != nil {
			t.Fatal(err)
		}
		defer s.Close()
		m, _ := s.Get("/parent")
		if m.RefCount != 1 {
			t.Fatalf("missing refcount after restart: %d", m.RefCount)
		}
		if err := s.Delete("/parent"); err != nil {
			t.Fatal(err)
		}
		msgs, _, err := s.Read("/child", ZeroOffset)
		if err != nil || string(messagesBytes(msgs)) != "old" {
			t.Fatalf("restart inheritance: %q %v", messagesBytes(msgs), err)
		}
	})
}
