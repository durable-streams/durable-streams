package store

import (
	"testing"
	"time"
)

func TestFileStoreReadPinsGenerationAcrossDeleteRecreate(t *testing.T) {
	s, err := NewFileStore(FileStoreConfig{DataDir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if _, _, err := s.Create("/stream", CreateOptions{ContentType: "text/plain", InitialData: []byte("old")}); err != nil {
		t.Fatal(err)
	}

	pinned := make(chan struct{})
	release := make(chan struct{})
	s.readPinnedHook = func() { close(pinned); <-release }
	readDone := make(chan []Message, 1)
	readErr := make(chan error, 1)
	go func() {
		messages, _, err := s.Read("/stream", ZeroOffset)
		readDone <- messages
		readErr <- err
	}()
	<-pinned

	mutationDone := make(chan error, 1)
	go func() {
		if err := s.Delete("/stream"); err != nil {
			mutationDone <- err
			return
		}
		_, _, err := s.Create("/stream", CreateOptions{ContentType: "text/plain", InitialData: []byte("new")})
		mutationDone <- err
	}()
	select {
	case err := <-mutationDone:
		t.Fatalf("generation changed during pinned read: %v", err)
	case <-time.After(30 * time.Millisecond):
	}
	close(release)
	if err := <-readErr; err != nil {
		t.Fatal(err)
	}
	if got := string(messagesBytes(<-readDone)); got != "old" {
		t.Fatalf("read spliced generations: %q", got)
	}
	if err := <-mutationDone; err != nil {
		t.Fatal(err)
	}
	s.readPinnedHook = nil
	messages, _, err := s.Read("/stream", ZeroOffset)
	if err != nil || string(messagesBytes(messages)) != "new" {
		t.Fatalf("new generation read: %q, %v", messagesBytes(messages), err)
	}
}
