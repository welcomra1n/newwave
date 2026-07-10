// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

// Reads past CLI agent sessions (Claude Code + Codex) from disk so the
// frontend session sidebar can list and resume them.

import (
	"bufio"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

const (
	cliSessionsMaxResults = 200 // cap returned entries
	cliSessionsScanLines  = 80  // max lines scanned per file for cwd/title
	cliSessionsTitleLen   = 100 // max title chars
)

type cliSessionCandidate struct {
	agent    string
	filePath string
	mtimeMs  int64
}

// GetCliSessionsCommand returns recent Claude/Codex sessions, newest first.
func (ws *WshServer) GetCliSessionsCommand(ctx context.Context) ([]wshrpc.CliSessionEntry, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return nil, err
	}

	candidates := make([]cliSessionCandidate, 0, 256)
	candidates = append(candidates, collectClaudeCandidates(home)...)
	candidates = append(candidates, collectCodexCandidates(home)...)

	// newest first, then bound the expensive per-file parse
	sort.Slice(candidates, func(i, j int) bool { return candidates[i].mtimeMs > candidates[j].mtimeMs })
	if len(candidates) > cliSessionsMaxResults {
		candidates = candidates[:cliSessionsMaxResults]
	}

	entries := make([]wshrpc.CliSessionEntry, 0, len(candidates))
	for _, c := range candidates {
		var entry wshrpc.CliSessionEntry
		var ok bool
		if c.agent == "claude" {
			entry, ok = parseClaudeSession(c)
		} else {
			entry, ok = parseCodexSession(c)
		}
		if ok {
			entries = append(entries, entry)
		}
	}
	return entries, nil
}

func collectClaudeCandidates(home string) []cliSessionCandidate {
	// ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl
	glob := filepath.Join(home, ".claude", "projects", "*", "*.jsonl")
	paths, err := filepath.Glob(glob)
	if err != nil {
		return nil
	}
	out := make([]cliSessionCandidate, 0, len(paths))
	for _, p := range paths {
		if fi, err := os.Stat(p); err == nil && !fi.IsDir() {
			out = append(out, cliSessionCandidate{agent: "claude", filePath: p, mtimeMs: fi.ModTime().UnixMilli()})
		}
	}
	return out
}

func collectCodexCandidates(home string) []cliSessionCandidate {
	// ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
	root := filepath.Join(home, ".codex", "sessions")
	out := make([]cliSessionCandidate, 0, 128)
	_ = filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return nil // skip unreadable dirs, keep walking
		}
		if d.IsDir() || !strings.HasSuffix(d.Name(), ".jsonl") {
			return nil
		}
		if fi, err := d.Info(); err == nil {
			out = append(out, cliSessionCandidate{agent: "codex", filePath: path, mtimeMs: fi.ModTime().UnixMilli()})
		}
		return nil
	})
	return out
}

// --- Claude parsing ---

type claudeLine struct {
	Type    string          `json:"type"`
	Cwd     string          `json:"cwd"`
	Message json.RawMessage `json:"message"`
}

type claudeMessage struct {
	Role    string          `json:"role"`
	Content json.RawMessage `json:"content"`
}

func parseClaudeSession(c cliSessionCandidate) (wshrpc.CliSessionEntry, bool) {
	entry := wshrpc.CliSessionEntry{
		Agent:     "claude",
		SessionId: strings.TrimSuffix(filepath.Base(c.filePath), ".jsonl"),
		Mtime:     c.mtimeMs,
		FilePath:  c.filePath,
	}
	f, err := os.Open(c.filePath)
	if err != nil {
		return entry, false
	}
	defer f.Close()

	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)
	for i := 0; i < cliSessionsScanLines && sc.Scan(); i++ {
		var ln claudeLine
		if json.Unmarshal(sc.Bytes(), &ln) != nil {
			continue
		}
		if entry.Cwd == "" && ln.Cwd != "" {
			entry.Cwd = ln.Cwd
		}
		if entry.Title == "" && ln.Type == "user" && len(ln.Message) > 0 {
			var msg claudeMessage
			if json.Unmarshal(ln.Message, &msg) == nil {
				entry.Title = cleanTitle(extractContentText(msg.Content))
			}
		}
		if entry.Cwd != "" && entry.Title != "" {
			break
		}
	}
	if entry.Title == "" {
		entry.Title = "(제목 없음)"
	}
	return entry, true
}

// --- Codex parsing ---

type codexMetaLine struct {
	Type    string `json:"type"`
	Payload struct {
		SessionId string `json:"session_id"`
		Cwd       string `json:"cwd"`
	} `json:"payload"`
}

type codexItemLine struct {
	Type    string `json:"type"`
	Payload struct {
		Type    string          `json:"type"`
		Role    string          `json:"role"`
		Content json.RawMessage `json:"content"`
	} `json:"payload"`
}

func parseCodexSession(c cliSessionCandidate) (wshrpc.CliSessionEntry, bool) {
	entry := wshrpc.CliSessionEntry{
		Agent:    "codex",
		Mtime:    c.mtimeMs,
		FilePath: c.filePath,
	}
	f, err := os.Open(c.filePath)
	if err != nil {
		return entry, false
	}
	defer f.Close()

	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)
	for i := 0; i < cliSessionsScanLines && sc.Scan(); i++ {
		b := sc.Bytes()
		if entry.SessionId == "" {
			var meta codexMetaLine
			if json.Unmarshal(b, &meta) == nil && meta.Type == "session_meta" {
				entry.SessionId = meta.Payload.SessionId
				entry.Cwd = meta.Payload.Cwd
				continue
			}
		}
		if entry.Title == "" {
			var item codexItemLine
			if json.Unmarshal(b, &item) == nil && item.Payload.Role == "user" && len(item.Payload.Content) > 0 {
				entry.Title = cleanTitle(extractContentText(item.Payload.Content))
			}
		}
		if entry.SessionId != "" && entry.Title != "" {
			break
		}
	}
	if entry.SessionId == "" {
		// no valid meta header -> not resumable, drop
		return entry, false
	}
	if entry.Title == "" {
		entry.Title = "(제목 없음)"
	}
	return entry, true
}

// --- shared helpers ---

// extractContentText pulls text from either a plain string content or an
// array of content blocks (claude: {type:text,text}, codex: {type:input_text,text}).
func extractContentText(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return s
	}
	var blocks []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	if json.Unmarshal(raw, &blocks) == nil {
		for _, b := range blocks {
			if b.Text != "" {
				return b.Text
			}
		}
	}
	return ""
}

func cleanTitle(s string) string {
	s = strings.TrimSpace(s)
	// collapse newlines/tabs into single spaces for a single-line list item
	s = strings.NewReplacer("\r", " ", "\n", " ", "\t", " ").Replace(s)
	for strings.Contains(s, "  ") {
		s = strings.ReplaceAll(s, "  ", " ")
	}
	// skip slash-command / meta noise prefixes when possible is left to UI; just truncate
	r := []rune(s)
	if len(r) > cliSessionsTitleLen {
		return string(r[:cliSessionsTitleLen]) + "…"
	}
	return s
}
