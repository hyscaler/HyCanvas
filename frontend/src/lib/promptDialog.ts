// Imperative prompt/alert dialogs that render as in-app modals (replacing native
// window.prompt/alert). Usable from anywhere - event handlers, command-menu run
// callbacks, store-adjacent code - via the promptText()/alertText() promises.
// A single <PromptHost /> mounted at the app root renders the active request.

import { create } from "zustand";

export type DialogReq =
  | {
      kind: "prompt";
      id: number;
      title: string;
      label?: string;
      placeholder?: string;
      defaultValue?: string;
      confirmText?: string;
      resolve: (value: string | null) => void;
    }
  | { kind: "alert"; id: number; title?: string; message: string; resolve: () => void };

let seq = 0;

interface DialogState {
  req: DialogReq | null;
  setReq: (req: DialogReq | null) => void;
}

export const useDialog = create<DialogState>((set) => ({
  req: null,
  setReq: (req) => set({ req }),
}));

/** Ask the user for a line of text. Resolves to the trimmed value, or null on cancel. */
export function promptText(opts: {
  title: string;
  label?: string;
  placeholder?: string;
  defaultValue?: string;
  confirmText?: string;
}): Promise<string | null> {
  return new Promise((resolve) => {
    useDialog.getState().setReq({ kind: "prompt", id: ++seq, ...opts, resolve });
  });
}

/** Show a message with an OK button. Resolves when dismissed. */
export function alertText(message: string, title?: string): Promise<void> {
  return new Promise((resolve) => {
    useDialog.getState().setReq({ kind: "alert", id: ++seq, title, message, resolve });
  });
}
