// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

// Reads past CLI agent sessions (Claude Code + Codex) from disk so the
// frontend session sidebar can list and resume them.

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/shirou/gopsutil/v4/process"

	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

const (
	cliSessionsMaxResults  = 500       // cap returned entries
	cliSessionsScanLines   = 80        // max lines scanned per file for cwd/title
	cliSessionsTitleLen    = 100       // max title chars
	cliSessionsSearchLines = 4000      // max lines scanned per file for content search
	cliSessionsTailBytes   = 96 * 1024 // bytes read from the end of a file for the last-message preview
	cliSessionsTailEntries = 120       // how many (newest) entries get that tail read
	cliSessionsPreviewLen  = 140       // max preview chars
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

	meta := readSessionMeta(home)

	entries := make([]wshrpc.CliSessionEntry, 0, len(candidates))
	for _, c := range candidates {
		var entry wshrpc.CliSessionEntry
		var ok bool
		if c.agent == "claude" {
			entry, ok = parseClaudeSession(c)
		} else {
			entry, ok = parseCodexSession(c)
		}
		if !ok {
			continue
		}
		if m, found := meta[entry.SessionId]; found {
			entry.Alias = m.Alias
			entry.Pinned = m.Pinned
			entry.Color = m.Color
			entry.Project = m.Project
		}
		entries = append(entries, entry)
	}

	// pinned first, then by recency
	sort.SliceStable(entries, func(i, j int) bool {
		if entries[i].Pinned != entries[j].Pinned {
			return entries[i].Pinned
		}
		return entries[i].Mtime > entries[j].Mtime
	})

	// Fill in the "where did this session leave off" preview. Only the newest N entries
	// pay the tail read — older ones scroll far down the sidebar and aren't worth the IO.
	limit := len(entries)
	if limit > cliSessionsTailEntries {
		limit = cliSessionsTailEntries
	}
	for i := 0; i < limit; i++ {
		fillTailPreview(&entries[i])
	}
	return entries, nil
}

// fillTailPreview reads the end of a session file to recover the last message text,
// who spoke it, and (claude) the model that answered. Bounded to the last
// cliSessionsTailBytes so a huge transcript costs one seek + one read.
func fillTailPreview(entry *wshrpc.CliSessionEntry) {
	f, err := os.Open(entry.FilePath)
	if err != nil {
		return
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil {
		return
	}
	offset := int64(0)
	if fi.Size() > cliSessionsTailBytes {
		offset = fi.Size() - cliSessionsTailBytes
	}
	if _, err := f.Seek(offset, 0); err != nil {
		return
	}
	buf, err := io.ReadAll(f)
	if err != nil {
		return
	}
	lines := strings.Split(string(buf), "\n")
	if offset > 0 && len(lines) > 0 {
		lines = lines[1:] // first line is a fragment of a record we seeked into
	}
	for i := len(lines) - 1; i >= 0; i-- {
		line := strings.TrimSpace(lines[i])
		if line == "" {
			continue
		}
		role, text, model := parseTranscriptLine(entry.Agent, []byte(line))
		if entry.Model == "" && model != "" {
			entry.Model = shortModelName(model)
		}
		if entry.LastMsg != "" || text == "" || isNoiseTitle(text) {
			continue
		}
		entry.LastMsg = truncRunes(cleanTitle(text), cliSessionsPreviewLen)
		entry.LastRole = role
		if entry.Model != "" {
			break
		}
	}
}

// parseTranscriptLine pulls (role, text, model) out of one jsonl record of either agent.
func parseTranscriptLine(agent string, b []byte) (string, string, string) {
	if agent == "claude" {
		var ln struct {
			Type    string `json:"type"`
			Message struct {
				Role    string          `json:"role"`
				Model   string          `json:"model"`
				Content json.RawMessage `json:"content"`
			} `json:"message"`
		}
		if json.Unmarshal(b, &ln) != nil {
			return "", "", ""
		}
		if ln.Type != "user" && ln.Type != "assistant" {
			return "", "", ln.Message.Model
		}
		return ln.Type, extractContentText(ln.Message.Content), ln.Message.Model
	}
	var item codexItemLine
	if json.Unmarshal(b, &item) != nil {
		return "", "", ""
	}
	if item.Payload.Role != "user" && item.Payload.Role != "assistant" {
		return "", "", ""
	}
	return item.Payload.Role, extractContentText(item.Payload.Content), ""
}

// shortModelName turns "claude-opus-5-20260101" into "opus-5" for a compact badge.
func shortModelName(model string) string {
	m := strings.TrimPrefix(model, "claude-")
	parts := strings.Split(m, "-")
	// drop a trailing YYYYMMDD date segment
	if len(parts) > 1 {
		last := parts[len(parts)-1]
		if len(last) == 8 && strings.Trim(last, "0123456789") == "" {
			parts = parts[:len(parts)-1]
		}
	}
	if len(parts) > 2 {
		parts = parts[:2]
	}
	return strings.Join(parts, "-")
}

func truncRunes(s string, max int) string {
	r := []rune(s)
	if len(r) <= max {
		return s
	}
	return string(r[:max]) + "…"
}

// GetLiveSessionsCommand returns session ids that are currently running as claude
// agents (interactive or background), so the UI can mark them "running" and warn
// before a resume that would be refused.
func (ws *WshServer) GetLiveSessionsCommand(ctx context.Context) ([]wshrpc.LiveSessionEntry, error) {
	ctx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "claude", "agents", "--json").Output()
	if err != nil {
		// claude not on PATH or no agents — non-fatal, just report none
		return []wshrpc.LiveSessionEntry{}, nil
	}
	var agents []struct {
		SessionId string `json:"sessionId"`
		Pid       int    `json:"pid"`
		Kind      string `json:"kind"`
		Status    string `json:"status"`
		State     string `json:"state"`
	}
	if err := json.Unmarshal(out, &agents); err != nil {
		return []wshrpc.LiveSessionEntry{}, nil
	}
	entries := make([]wshrpc.LiveSessionEntry, 0, len(agents))
	for _, a := range agents {
		if a.SessionId == "" {
			continue
		}
		// background agents have no pid — they belong to no window at all
		host, isSelf := resolveSessionHost(a.Pid)
		if a.Kind == "background" {
			host = "백그라운드 에이전트"
			isSelf = false
		} else if host == "" {
			host = "알 수 없는 앱"
		}
		entries = append(entries, wshrpc.LiveSessionEntry{
			SessionId: a.SessionId,
			Pid:       a.Pid,
			Host:      host,
			IsSelf:    isSelf,
			Kind:      a.Kind,
			Status:    firstNonEmpty(a.Status, a.State),
		})
	}
	return entries, nil
}

// hostAppNames maps a process name to the app label shown in the sidebar. Matched
// against the ancestors of the agent process, nearest first.
var hostAppNames = map[string]string{
	"newwave":          "NewWave",
	"wavesrv":          "NewWave",
	"wavesrv.x64":      "NewWave",
	"electron":         "NewWave (개발)",
	"windowsterminal":  "Windows Terminal",
	"powershell":       "PowerShell",
	"pwsh":             "PowerShell",
	"cmd":              "명령 프롬프트",
	"wt":               "Windows Terminal",
	"wezterm-gui":      "WezTerm",
	"alacritty":        "Alacritty",
	"kitty":            "kitty",
	"iterm2":           "iTerm2",
	"terminal":         "Terminal",
	"code":             "VS Code",
	"cursor":           "Cursor",
	"conhost":          "콘솔 창",
	"openconsole":      "콘솔 창",
	"windowsterminal!": "Windows Terminal",
}

// resolveSessionHost walks up the agent process's ancestors to find which app it is
// running under, so a session started in an outside PowerShell isn't confused with one
// running in this app. Returns a display label and whether the owner is this process tree.
func resolveSessionHost(pid int) (string, bool) {
	if pid <= 0 {
		return "", false
	}
	selfPid := int32(os.Getpid())
	proc, err := process.NewProcess(int32(pid))
	if err != nil {
		return "", false
	}
	var fallback string
	for i := 0; i < 12 && proc != nil; i++ {
		name, nameErr := proc.Name()
		if nameErr == nil && name != "" {
			if proc.Pid == selfPid {
				return "NewWave", true
			}
			key := strings.ToLower(strings.TrimSuffix(name, ".exe"))
			if label, found := hostAppNames[key]; found {
				return label, strings.HasPrefix(label, "NewWave")
			}
			// remember the first ancestor above claude itself as a last resort
			if fallback == "" && key != "claude" && key != "node" && key != "bash" && key != "sh" {
				fallback = name
			}
		}
		parent, perr := proc.Parent()
		if perr != nil || parent == nil || parent.Pid == proc.Pid {
			break
		}
		proc = parent
	}
	return fallback, false
}

// KillLiveSessionCommand stops a running claude agent by killing its process tree.
// Used to clear a "실행중" session that's actually a stale/leftover background agent.
func (ws *WshServer) KillLiveSessionCommand(ctx context.Context, sessionId string) error {
	sessionId = strings.TrimSpace(sessionId)
	if sessionId == "" {
		return fmt.Errorf("sessionId required")
	}
	lctx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	out, err := exec.CommandContext(lctx, "claude", "agents", "--json").Output()
	if err != nil {
		return fmt.Errorf("could not list agents: %w", err)
	}
	var agents []struct {
		SessionId string `json:"sessionId"`
		Pid       int    `json:"pid"`
	}
	if err := json.Unmarshal(out, &agents); err != nil {
		return fmt.Errorf("could not parse agents: %w", err)
	}
	var pid int
	for _, a := range agents {
		if a.SessionId == sessionId {
			pid = a.Pid
			break
		}
	}
	if pid <= 0 {
		return fmt.Errorf("no live agent for session")
	}
	return killProcessTree(pid)
}

// SearchCliSessionsCommand returns sessions whose title/alias or file content matches the query.
// Reuses GetCliSessions (parsed titles + user meta), then content-scans only the entries that
// don't already match by title, so a title hit never pays the file-read cost.
func (ws *WshServer) SearchCliSessionsCommand(ctx context.Context, data wshrpc.CliSessionSearchReq) ([]wshrpc.CliSessionEntry, error) {
	entries, err := ws.GetCliSessionsCommand(ctx)
	if err != nil {
		return nil, err
	}
	q := strings.ToLower(strings.TrimSpace(data.Query))
	if q == "" {
		return entries, nil
	}
	out := make([]wshrpc.CliSessionEntry, 0, len(entries))
	for _, e := range entries {
		if strings.Contains(strings.ToLower(e.Alias), q) || strings.Contains(strings.ToLower(e.Title), q) {
			out = append(out, e)
			continue
		}
		if snip, ok := fileMatchSnippet(e.FilePath, q); ok {
			e.Snippet = snip
			out = append(out, e)
		}
	}
	return out, nil
}

// fileMatchSnippet scans a session file for a case-insensitive substring, bounded to keep
// search responsive. Returns the matched line (trimmed) as a preview snippet.
func fileMatchSnippet(filePath, lowerQuery string) (string, bool) {
	f, err := os.Open(filePath)
	if err != nil {
		return "", false
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)
	for i := 0; i < cliSessionsSearchLines && sc.Scan(); i++ {
		line := sc.Text()
		idx := strings.Index(strings.ToLower(line), lowerQuery)
		if idx < 0 {
			continue
		}
		// window a snippet around the match, cleaned to one line
		snippet := cleanTitle(line)
		if r := []rune(snippet); len(r) > 120 {
			snippet = string(r[:120]) + "…"
		}
		return snippet, true
	}
	return "", false
}

// --- user metadata (alias/pin) store: ~/.newwave/sessions-meta.json ---

type sessionMeta struct {
	Alias   string `json:"alias,omitempty"`
	Pinned  bool   `json:"pinned,omitempty"`
	Color   string `json:"color,omitempty"`
	Project string `json:"project,omitempty"`
}

func sessionMetaPath(home string) string {
	return filepath.Join(home, ".newwave", "sessions-meta.json")
}

func readSessionMeta(home string) map[string]sessionMeta {
	out := make(map[string]sessionMeta)
	data, err := os.ReadFile(sessionMetaPath(home))
	if err != nil {
		return out
	}
	_ = json.Unmarshal(data, &out) // corrupt file -> empty map, non-fatal
	return out
}

func writeSessionMeta(home string, meta map[string]sessionMeta) error {
	dir := filepath.Join(home, ".newwave")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(meta, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(sessionMetaPath(home), data, 0o644)
}

// SetCliSessionMetaCommand sets alias/pinned for a session (nil fields unchanged).
func (ws *WshServer) SetCliSessionMetaCommand(ctx context.Context, data wshrpc.CliSessionMetaReq) error {
	if data.SessionId == "" {
		return nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return err
	}
	meta := readSessionMeta(home)
	m := meta[data.SessionId]
	if data.Alias != nil {
		m.Alias = strings.TrimSpace(*data.Alias)
	}
	if data.Pinned != nil {
		m.Pinned = *data.Pinned
	}
	if data.Color != nil {
		m.Color = strings.TrimSpace(*data.Color)
	}
	if data.Project != nil {
		m.Project = strings.TrimSpace(*data.Project)
	}
	if m.Alias == "" && !m.Pinned && m.Color == "" && m.Project == "" {
		delete(meta, data.SessionId) // no metadata left -> drop entry
	} else {
		meta[data.SessionId] = m
	}
	return writeSessionMeta(home, meta)
}

// SetCliSessionsProjectCommand assigns many sessions to a folder atomically.
func (ws *WshServer) SetCliSessionsProjectCommand(ctx context.Context, data wshrpc.CliBulkProjectReq) error {
	home, err := os.UserHomeDir()
	if err != nil {
		return err
	}
	proj := strings.TrimSpace(data.Project)
	meta := readSessionMeta(home)
	for _, id := range data.SessionIds {
		if id == "" {
			continue
		}
		m := meta[id]
		m.Project = proj
		if m.Alias == "" && !m.Pinned && m.Color == "" && m.Project == "" {
			delete(meta, id)
		} else {
			meta[id] = m
		}
	}
	return writeSessionMeta(home, meta)
}

// --- project list: ~/.newwave/projects.json ---

func projectsPath(home string) string {
	return filepath.Join(home, ".newwave", "projects.json")
}

// GetCliProjectsCommand returns the ordered list of user-created project names.
func (ws *WshServer) GetCliProjectsCommand(ctx context.Context) ([]string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return nil, err
	}
	out := []string{}
	data, err := os.ReadFile(projectsPath(home))
	if err != nil {
		return out, nil // no file yet -> empty list
	}
	_ = json.Unmarshal(data, &out)
	return out, nil
}

// SetCliProjectsCommand replaces the project list (create/rename/delete/reorder).
func (ws *WshServer) SetCliProjectsCommand(ctx context.Context, data []string) error {
	home, err := os.UserHomeDir()
	if err != nil {
		return err
	}
	dir := filepath.Join(home, ".newwave")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	if data == nil {
		data = []string{}
	}
	b, err := json.MarshalIndent(data, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(projectsPath(home), b, 0o644)
}

// DeleteCliSessionCommand moves a session's jsonl to a trash dir (recoverable,
// not a hard delete) so the sidebar drops it without destroying history.
func (ws *WshServer) DeleteCliSessionCommand(ctx context.Context, filePath string) error {
	if filePath == "" {
		return nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return err
	}
	// guard: only allow deleting under the known session roots
	claudeRoot := filepath.Join(home, ".claude", "projects")
	codexRoot := filepath.Join(home, ".codex", "sessions")
	abs, err := filepath.Abs(filePath)
	if err != nil {
		return err
	}
	if !strings.HasPrefix(abs, claudeRoot) && !strings.HasPrefix(abs, codexRoot) {
		return os.ErrPermission
	}
	trashDir := filepath.Join(home, ".newwave", "trash")
	if err := os.MkdirAll(trashDir, 0o755); err != nil {
		return err
	}
	dest := filepath.Join(trashDir, filepath.Base(abs))
	// avoid clobbering an existing trashed file with same name
	if _, statErr := os.Stat(dest); statErr == nil {
		dest = filepath.Join(trashDir, filepath.Base(filepath.Dir(abs))+"_"+filepath.Base(abs))
	}
	return os.Rename(abs, dest)
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
	var bestTitle, fallbackTitle string
	for i := 0; i < cliSessionsScanLines && sc.Scan(); i++ {
		var ln claudeLine
		if json.Unmarshal(sc.Bytes(), &ln) != nil {
			continue
		}
		if entry.Cwd == "" && ln.Cwd != "" {
			entry.Cwd = ln.Cwd
		}
		if bestTitle == "" && ln.Type == "user" && len(ln.Message) > 0 {
			var msg claudeMessage
			if json.Unmarshal(ln.Message, &msg) == nil {
				pickTitle(cleanTitle(extractContentText(msg.Content)), &bestTitle, &fallbackTitle)
			}
		}
		if entry.Cwd != "" && bestTitle != "" {
			break
		}
	}
	entry.Title = firstNonEmpty(bestTitle, fallbackTitle, "(제목 없음)")
	return entry, true
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if v != "" {
			return v
		}
	}
	return ""
}

// --- Codex parsing ---

type codexMetaLine struct {
	Type    string `json:"type"`
	Payload struct {
		SessionId string `json:"session_id"`
		Id        string `json:"id"` // older codex format stores the id here
		Cwd       string `json:"cwd"`
	} `json:"payload"`
}

// codexIdFromFilename derives the session UUID from a rollout filename as a
// last-resort fallback: rollout-<timestamp>-<uuid>.jsonl (uuid = final 36 chars).
func codexIdFromFilename(filePath string) string {
	base := strings.TrimSuffix(filepath.Base(filePath), ".jsonl")
	if len(base) < 36 {
		return ""
	}
	return base[len(base)-36:]
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
	var bestTitle, fallbackTitle string
	for i := 0; i < cliSessionsScanLines && sc.Scan(); i++ {
		b := sc.Bytes()
		if entry.SessionId == "" {
			var meta codexMetaLine
			if json.Unmarshal(b, &meta) == nil && meta.Type == "session_meta" {
				entry.SessionId = firstNonEmpty(meta.Payload.SessionId, meta.Payload.Id)
				entry.Cwd = meta.Payload.Cwd
				continue
			}
		}
		if bestTitle == "" {
			var item codexItemLine
			if json.Unmarshal(b, &item) == nil && item.Payload.Role == "user" && len(item.Payload.Content) > 0 {
				pickTitle(cleanTitle(extractContentText(item.Payload.Content)), &bestTitle, &fallbackTitle)
			}
		}
		if entry.SessionId != "" && bestTitle != "" {
			break
		}
	}
	if entry.SessionId == "" {
		// meta header missing the id -> fall back to the filename UUID
		entry.SessionId = codexIdFromFilename(c.filePath)
	}
	if entry.SessionId == "" {
		// still no id -> not resumable, drop
		return entry, false
	}
	entry.Title = firstNonEmpty(bestTitle, fallbackTitle, "(제목 없음)")
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

// isNoiseTitle reports whether a candidate title is boilerplate/noise rather
// than a real user description (system reminders, image pastes, command
// wrappers, slash commands, agent preambles, continuation banners).
func isNoiseTitle(s string) bool {
	t := strings.TrimSpace(s)
	if t == "" {
		return true
	}
	noisePrefixes := []string{
		"<system-reminder", "<command-", "<local-command", "[Image",
		"# AGENTS.md", "Caveat:", "This session is being continued",
		"<user-prompt-submit-hook", "<persisted-", "<budget", "```",
	}
	for _, p := range noisePrefixes {
		if strings.HasPrefix(t, p) {
			return true
		}
	}
	// bare slash command, e.g. "/resume", "/clear"
	if strings.HasPrefix(t, "/") && !strings.ContainsAny(t, " \t") && len(t) < 24 {
		return true
	}
	// bare filesystem path with no prose (e.g. a dropped file path) — not a real prompt.
	// unix "/Users/…/x" or windows "C:\…"; requires a path separator and no spaces.
	if !strings.ContainsAny(t, " \t") {
		if strings.HasPrefix(t, "/") && strings.Count(t, "/") >= 2 {
			return true
		}
		if len(t) > 2 && t[1] == ':' && (t[2] == '\\' || t[2] == '/') {
			return true
		}
	}
	return false
}

// pickTitle updates best/fallback trackers with a new candidate. Returns true
// once a non-noise title has been chosen (caller can stop scanning).
func pickTitle(candidate string, best *string, fallback *string) bool {
	if candidate == "" {
		return false
	}
	if *fallback == "" {
		*fallback = candidate
	}
	if *best == "" && !isNoiseTitle(candidate) {
		*best = candidate
		return true
	}
	return *best != ""
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
