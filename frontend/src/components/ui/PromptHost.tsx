// Renders the active prompt/alert request from the dialog store as a modal.
// Mount once at the editor root. See lib/promptDialog.ts for the imperative API.

import { useEffect, useRef } from "react";
import { Modal } from "./Modal";
import { Button } from "./Button";
import { useDialog } from "@/lib/promptDialog";
import { tr } from "@/lib/i18n";

export function PromptHost() {
  const req = useDialog((s) => s.req);
  const setReq = useDialog((s) => s.setReq);
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus + select the field when a prompt opens (no state update -> no cascade).
  useEffect(() => {
    if (req?.kind !== "prompt") return;
    const t = setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    }, 0);
    return () => clearTimeout(t);
  }, [req]);

  if (!req) return null;

  const cancel = () => {
    setReq(null);
    if (req.kind === "prompt") req.resolve(null);
    else req.resolve();
  };
  const confirm = () => {
    // Confirm returns the trimmed value (possibly empty); only Cancel returns
    // null, so callers can tell "cleared the field" from "cancelled".
    const value = inputRef.current?.value.trim() ?? "";
    setReq(null);
    if (req.kind === "prompt") req.resolve(value);
    else req.resolve();
  };

  return (
    <Modal open onClose={cancel} title={req.kind === "alert" ? req.title ?? tr("ui.notice") : req.title}>
      {req.kind === "prompt" ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            confirm();
          }}
          className="flex flex-col gap-4"
        >
          {req.label && <label className="text-sm font-medium text-neutral-700">{req.label}</label>}
          <input
            key={req.id}
            ref={inputRef}
            defaultValue={req.defaultValue ?? ""}
            placeholder={req.placeholder}
            className="h-11 rounded-xl border border-neutral-200 bg-surface px-3.5 text-sm text-neutral-900 placeholder:text-neutral-400 outline-none transition focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
          />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" size="sm" onClick={cancel}>{tr("ui.cancel")}</Button>
            <Button type="submit" size="sm">{req.confirmText ?? "OK"}</Button>
          </div>
        </form>
      ) : (
        <div className="flex flex-col gap-4">
          <p className="text-sm text-neutral-700">{req.message}</p>
          <div className="flex justify-end">
            <Button size="sm" onClick={confirm}>OK</Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
