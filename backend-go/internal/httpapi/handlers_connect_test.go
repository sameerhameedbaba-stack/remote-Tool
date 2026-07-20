package httpapi

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/remote-support/backend/internal/config"
)

func TestResolveClientFile(t *testing.T) {
	dir := t.TempDir()
	generic := filepath.Join(dir, "remote-agent.exe")
	alice := filepath.Join(dir, "alice.exe")
	if err := os.WriteFile(generic, []byte("generic"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(alice, []byte("alice"), 0o644); err != nil {
		t.Fatal(err)
	}

	s := &Server{cfg: &config.Config{ConnectClientDir: dir}}

	t.Run("per-technician installer wins", func(t *testing.T) {
		got, ok := s.resolveClientFile("alice")
		if !ok || got != alice {
			t.Fatalf("got %q ok=%v, want %q", got, ok, alice)
		}
	})

	t.Run("falls back to generic when no per-tech file", func(t *testing.T) {
		got, ok := s.resolveClientFile("bob")
		if !ok || got != generic {
			t.Fatalf("got %q ok=%v, want %q", got, ok, generic)
		}
	})

	t.Run("empty username falls back", func(t *testing.T) {
		got, ok := s.resolveClientFile("")
		if !ok || got != generic {
			t.Fatalf("got %q ok=%v, want %q", got, ok, generic)
		}
	})

	// Path-traversal / injection attempts must never escape the dir; they fall
	// back to the generic client instead.
	for _, bad := range []string{"../../etc/passwd", "..", "a/b", "alice.exe", "AL/ICE", ".ssh"} {
		t.Run("rejects unsafe: "+bad, func(t *testing.T) {
			got, ok := s.resolveClientFile(bad)
			if !ok || got != generic {
				t.Fatalf("unsafe %q resolved to %q (ok=%v); must fall back to generic", bad, got, ok)
			}
		})
	}
}

func TestResolveClientFile_NoneAvailable(t *testing.T) {
	s := &Server{cfg: &config.Config{ConnectClientDir: t.TempDir()}}
	if _, ok := s.resolveClientFile("alice"); ok {
		t.Fatal("expected ok=false when no installer files exist")
	}
}

func TestResolveClientFile_EmptyDir(t *testing.T) {
	s := &Server{cfg: &config.Config{ConnectClientDir: ""}}
	if _, ok := s.resolveClientFile("alice"); ok {
		t.Fatal("expected ok=false when ConnectClientDir is empty")
	}
}
