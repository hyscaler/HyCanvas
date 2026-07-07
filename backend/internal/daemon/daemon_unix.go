//go:build !windows

package daemon

import (
	"errors"
	"syscall"
)

// detachAttr makes the spawned server its own session leader so it survives
// the parent command and the terminal it ran from.
func detachAttr() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{Setsid: true}
}

// processAlive reports whether pid refers to a live process (signal 0 probe;
// EPERM still means the process exists).
func processAlive(pid int) bool {
	err := syscall.Kill(pid, 0)
	return err == nil || errors.Is(err, syscall.EPERM)
}

// terminate asks the process to shut down gracefully; the server already
// handles SIGTERM with a drain.
func terminate(pid int) error {
	return syscall.Kill(pid, syscall.SIGTERM)
}

// forceKill is the last resort after the grace window.
func forceKill(pid int) error {
	return syscall.Kill(pid, syscall.SIGKILL)
}
