// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

//go:build !windows

package wshserver

import (
	"os"
	"syscall"
)

// killProcessTree kills the process group (negative pid) so children die too,
// falling back to the single process if it isn't a group leader.
func killProcessTree(pid int) error {
	if pgid, err := syscall.Getpgid(pid); err == nil {
		if err := syscall.Kill(-pgid, syscall.SIGKILL); err == nil {
			return nil
		}
	}
	proc, err := os.FindProcess(pid)
	if err != nil {
		return err
	}
	return proc.Kill()
}
