//go:build windows

package daemon

import (
	"os"
	"syscall"

	"golang.org/x/sys/windows"
)

// detachAttr detaches the spawned server from the parent console so it keeps
// running after the terminal closes.
func detachAttr() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{
		CreationFlags: windows.DETACHED_PROCESS | windows.CREATE_NEW_PROCESS_GROUP,
		HideWindow:    true,
	}
}

// processAlive reports whether pid refers to a live process.
func processAlive(pid int) bool {
	h, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(pid))
	if err != nil {
		return false
	}
	defer windows.CloseHandle(h)
	var code uint32
	if err := windows.GetExitCodeProcess(h, &code); err != nil {
		return false
	}
	return code == 259 // STILL_ACTIVE
}

// terminate has no graceful signal on Windows; Kill is the stop mechanism.
func terminate(pid int) error {
	p, err := os.FindProcess(pid)
	if err != nil {
		return err
	}
	return p.Kill()
}

func forceKill(pid int) error {
	return terminate(pid)
}
