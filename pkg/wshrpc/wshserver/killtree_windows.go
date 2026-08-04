// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

//go:build windows

package wshserver

import (
	"fmt"
	"os/exec"
	"strconv"
)

// killProcessTree force-kills a process and its children (taskkill /T).
func killProcessTree(pid int) error {
	cmd := exec.Command("taskkill", "/F", "/T", "/PID", strconv.Itoa(pid))
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("taskkill failed: %v (%s)", err, string(out))
	}
	return nil
}
