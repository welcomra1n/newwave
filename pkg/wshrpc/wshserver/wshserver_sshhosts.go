// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// SSH host management for NewWave: a friendly form to add/list/remove SSH
// connections, persisted to the standard ~/.ssh/config so they interoperate
// with Wave's native connection typeahead. NewWave-managed blocks are fenced
// with marker comments so hand-written entries are never touched.
package wshserver

import (
	"bufio"
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

const (
	sshHostMarkerBegin = "# >>> NewWave managed:"
	sshHostMarkerEnd   = "# <<< NewWave managed"
)

func sshConfigPath() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".ssh", "config"), nil
}

// GetSshHostsCommand parses ~/.ssh/config and returns concrete (non-wildcard) hosts.
func (ws *WshServer) GetSshHostsCommand(ctx context.Context) ([]wshrpc.SshHostEntry, error) {
	path, err := sshConfigPath()
	if err != nil {
		return nil, err
	}
	f, err := os.Open(path)
	if err != nil {
		if os.IsNotExist(err) {
			return []wshrpc.SshHostEntry{}, nil
		}
		return nil, err
	}
	defer f.Close()

	out := make([]wshrpc.SshHostEntry, 0, 16)
	var cur *wshrpc.SshHostEntry
	managed := false
	flush := func() {
		if cur != nil && cur.Alias != "" && !strings.ContainsAny(cur.Alias, "*?") {
			out = append(out, *cur)
		}
		cur = nil
	}
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		raw := sc.Text()
		line := strings.TrimSpace(raw)
		if strings.HasPrefix(line, sshHostMarkerBegin) {
			managed = true
			continue
		}
		if strings.HasPrefix(line, sshHostMarkerEnd) {
			managed = false
			continue
		}
		if line == "" || (strings.HasPrefix(line, "#")) {
			continue
		}
		key, val, ok := splitSshLine(line)
		if !ok {
			continue
		}
		switch strings.ToLower(key) {
		case "host":
			flush()
			cur = &wshrpc.SshHostEntry{Alias: val, Managed: managed}
		case "hostname":
			if cur != nil {
				cur.HostName = val
			}
		case "user":
			if cur != nil {
				cur.User = val
			}
		case "port":
			if cur != nil {
				cur.Port = val
			}
		case "identityfile":
			if cur != nil {
				cur.IdentityFile = val
			}
		}
	}
	flush()
	return out, nil
}

func splitSshLine(line string) (string, string, bool) {
	// "Key value" or "Key=value"
	if i := strings.IndexAny(line, " \t="); i > 0 {
		key := strings.TrimSpace(line[:i])
		val := strings.TrimSpace(strings.TrimLeft(line[i:], " \t="))
		if key != "" && val != "" {
			return key, val, true
		}
	}
	return "", "", false
}

// SetSshHostCommand upserts a NewWave-managed host block in ~/.ssh/config.
func (ws *WshServer) SetSshHostCommand(ctx context.Context, data wshrpc.SshHostEntry) error {
	alias := strings.TrimSpace(data.Alias)
	host := strings.TrimSpace(data.HostName)
	if alias == "" || host == "" {
		return fmt.Errorf("alias and hostname are required")
	}
	if strings.ContainsAny(alias, " \t") {
		return fmt.Errorf("alias cannot contain whitespace")
	}
	path, err := sshConfigPath()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	existing, _ := os.ReadFile(path) // missing -> empty
	body := stripManagedBlock(string(existing), alias)

	var b strings.Builder
	b.WriteString(strings.TrimRight(body, "\n"))
	if b.Len() > 0 {
		b.WriteString("\n\n")
	}
	b.WriteString(fmt.Sprintf("%s %s\n", sshHostMarkerBegin, alias))
	b.WriteString(fmt.Sprintf("Host %s\n", alias))
	b.WriteString(fmt.Sprintf("    HostName %s\n", host))
	if u := strings.TrimSpace(data.User); u != "" {
		b.WriteString(fmt.Sprintf("    User %s\n", u))
	}
	if p := strings.TrimSpace(data.Port); p != "" && p != "22" {
		b.WriteString(fmt.Sprintf("    Port %s\n", p))
	}
	if id := strings.TrimSpace(data.IdentityFile); id != "" {
		b.WriteString(fmt.Sprintf("    IdentityFile %s\n", id))
	}
	b.WriteString(sshHostMarkerEnd + "\n")

	return os.WriteFile(path, []byte(b.String()), 0o600)
}

// DeleteSshHostCommand removes a NewWave-managed host block (hand-written ones are left alone).
func (ws *WshServer) DeleteSshHostCommand(ctx context.Context, alias string) error {
	alias = strings.TrimSpace(alias)
	if alias == "" {
		return fmt.Errorf("alias required")
	}
	path, err := sshConfigPath()
	if err != nil {
		return err
	}
	existing, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	body := stripManagedBlock(string(existing), alias)
	return os.WriteFile(path, []byte(body), 0o600)
}

// stripManagedBlock removes the NewWave-managed block for the given alias, if present.
func stripManagedBlock(content, alias string) string {
	lines := strings.Split(content, "\n")
	out := make([]string, 0, len(lines))
	target := sshHostMarkerBegin + " " + alias
	skipping := false
	for _, ln := range lines {
		t := strings.TrimSpace(ln)
		if !skipping && t == target {
			skipping = true
			continue
		}
		if skipping {
			if strings.HasPrefix(t, sshHostMarkerEnd) {
				skipping = false
			}
			continue
		}
		out = append(out, ln)
	}
	return strings.TrimRight(strings.Join(out, "\n"), "\n") + "\n"
}
