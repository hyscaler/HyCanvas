// Whiteboard focus (full-screen) mode. A board-only view state that hides the
// editor chrome (top bar, left tool rail, right Properties panel) so only the
// infinite canvas and the floating board toolbar remain. Kept in its own tiny
// store so both the editor shell (EditorApp, which hides the chrome) and the
// board's floating toolbar (WhiteboardSurface, which offers a toggle) can read
// and drive it without threading props through the generic DocumentSurface.
//
// The enter/exit helpers also best-effort drive the browser Fullscreen API so
// the OS/browser chrome goes too; they MUST be called from a user gesture
// (a click) for requestFullscreen to be allowed. EditorApp reconciles the store
// with native fullscreen via a `fullscreenchange` listener, so leaving native
// fullscreen by any means (Esc, F11) also clears focus mode.

import { create } from "zustand";

interface BoardFocusState {
  focus: boolean;
  setFocus: (v: boolean) => void;
}

export const useBoardFocus = create<BoardFocusState>((set) => ({
  focus: false,
  setFocus: (v) => set({ focus: v }),
}));

/** Enter focus mode and request native browser fullscreen (best effort). */
export function enterBoardFocus(): void {
  useBoardFocus.getState().setFocus(true);
  if (typeof document === "undefined") return;
  try {
    void document.documentElement.requestFullscreen?.();
  } catch {
    /* fullscreen denied/unsupported: focus mode still hides the chrome */
  }
}

/** Exit focus mode and leave native fullscreen if we are in it. */
export function exitBoardFocus(): void {
  useBoardFocus.getState().setFocus(false);
  if (typeof document === "undefined") return;
  try {
    if (document.fullscreenElement) void document.exitFullscreen?.();
  } catch {
    /* ignore */
  }
}

export function toggleBoardFocus(): void {
  if (useBoardFocus.getState().focus) exitBoardFocus();
  else enterBoardFocus();
}
