// "Install app" shortcut: installs HyCanvas as an app (its own window and a
// home screen or dock icon). Shown only where installing is possible and the
// app is not already running installed; see lib/installPrompt.ts.

import { useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { MonitorDown, Share, SquarePlus } from "lucide-react";
import { installState, promptInstall, subscribeInstallState, type InstallState } from "@/lib/installPrompt";
import { Modal } from "@/components/ui/Modal";
import { tr } from "@/lib/i18n";

const serverState = (): InstallState => "none";

export function InstallAppButton() {
  const state = useSyncExternalStore(subscribeInstallState, installState, serverState);
  const [steps, setSteps] = useState(false);
  if (state === "none") return null;
  const label = tr("dashboard.install_app");
  return (
    <>
      <button
        type="button"
        onClick={() => (state === "prompt" ? void promptInstall() : setSteps(true))}
        aria-label={label}
        title={tr("dashboard.install_app_hint")}
        className="flex h-9 shrink-0 items-center gap-1.5 rounded-lg px-2 text-sm font-medium text-neutral-600 transition hover:bg-neutral-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-400 sm:px-2.5"
      >
        <MonitorDown size={18} />
        <span className="hidden lg:inline">{label}</span>
      </button>
      {/* Portaled to the app root: the dashboard header's backdrop blur makes
          it the box fixed children position against, which pinned the dialog
          to the header. The root (not <body>) keeps the app font. */}
      {steps &&
        createPortal(
          <Modal open={steps} onClose={() => setSteps(false)} title={label}>
            <p className="text-sm text-neutral-600">{tr("dashboard.install_app_ios_intro")}</p>
            <ol className="mt-3 space-y-2.5 text-sm text-neutral-700">
              <li className="flex items-center gap-2.5">
                <Share size={16} className="shrink-0 text-brand-ink" /> {tr("dashboard.install_app_ios_step_share")}
              </li>
              <li className="flex items-center gap-2.5">
                <SquarePlus size={16} className="shrink-0 text-brand-ink" /> {tr("dashboard.install_app_ios_step_add")}
              </li>
            </ol>
          </Modal>,
          document.querySelector("[data-app-root]") ?? document.body,
        )}
    </>
  );
}
