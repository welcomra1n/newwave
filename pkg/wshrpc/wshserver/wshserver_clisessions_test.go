package wshserver

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

// deleting a claude session must hide it even when the agent recreates the file
func TestDeleteHidesRecreatedSession(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)

	projDir := filepath.Join(home, ".claude", "projects", "proj")
	if err := os.MkdirAll(projDir, 0o755); err != nil {
		t.Fatal(err)
	}
	sessionId := "11111111-2222-3333-4444-555555555555"
	path := filepath.Join(projDir, sessionId+".jsonl")
	line := `{"type":"user","cwd":"C:\tmp","message":{"role":"user","content":"hello there"}}` + "\n"
	if err := os.WriteFile(path, []byte(line), 0o644); err != nil {
		t.Fatal(err)
	}

	ws := &WshServer{}
	before, err := ws.GetCliSessionsCommand(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if len(before) != 1 {
		t.Fatalf("expected 1 session before delete, got %d", len(before))
	}

	if err := ws.DeleteCliSessionCommand(t.Context(), path); err != nil {
		t.Fatalf("delete failed: %v", err)
	}
	if _, err := os.Stat(path); err == nil {
		t.Fatal("transcript should have moved to trash")
	}

	// the running agent writes again at the same path
	if err := os.WriteFile(path, []byte(line), 0o644); err != nil {
		t.Fatal(err)
	}
	after, err := ws.GetCliSessionsCommand(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if len(after) != 0 {
		t.Fatalf("recreated session should stay hidden, got %d: %+v", len(after), after)
	}

}

// setting other metadata later must not wipe the deleted flag
func TestSessionMetaKeepsDeletedFlag(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	if err := markSessionDeleted(home, "abc"); err != nil {
		t.Fatal(err)
	}
	empty := ""
	ws := &WshServer{}
	if err := ws.SetCliSessionMetaCommand(t.Context(), wshrpc.CliSessionMetaReq{SessionId: "abc", Alias: &empty}); err != nil {
		t.Fatal(err)
	}
	if !readSessionMeta(home)["abc"].Deleted {
		t.Fatal("deleted flag was pruned by a metadata update")
	}
}
