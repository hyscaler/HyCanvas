// "Install the app" shortcuts: install HyCanvas as an app (its own window and
// a home screen or dock icon). The header button shows only where the browser
// can install directly or is iPhone/iPad Safari; the account menu item also
// covers phone browsers that install from their own menu. Neither shows when
// the app is already running installed; see lib/installPrompt.ts.

import { useState, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { EllipsisVertical, MonitorDown, Share, SquarePlus } from "lucide-react";
import { installState, promptInstall, subscribeInstallState, type InstallState } from "@/lib/installPrompt";
import { Modal } from "@/components/ui/Modal";
import { tr } from "@/lib/i18n";

const serverState = (): InstallState => "none";

/** Install state plus the action and the by-hand steps dialog. Render
 *  `dialog` somewhere that stays mounted (a menu that closes on click would
 *  take the dialog with it). */
export function useInstallApp(): { state: InstallState; install: () => void; dialog: ReactNode } {
  const state = useSyncExternalStore(subscribeInstallState, installState, serverState);
  const [steps, setSteps] = useState(false);
  const install = () => (state === "prompt" ? void promptInstall() : setSteps(true));
  const ios = state !== "manual";
  // Portaled to the app root: the dashboard header's backdrop blur makes it
  // the box fixed children position against, which pinned the dialog to the
  // header. The root (not <body>) keeps the app font.
  const dialog = steps
    ? createPortal(
        <Modal open={steps} onClose={() => setSteps(false)} title={tr("dashboard.install_app")}>
          <p className="text-sm text-neutral-600">{tr("dashboard.install_app_ios_intro")}</p>
          <ol className="mt-3 space-y-2.5 text-sm text-neutral-700">
            <li className="flex items-center gap-2.5">
              {ios ? <Share size={16} className="shrink-0 text-brand-ink" /> : <EllipsisVertical size={16} className="shrink-0 text-brand-ink" />}{" "}
              {ios ? tr("dashboard.install_app_ios_step_share") : tr("dashboard.install_app_step_menu")}
            </li>
            <li className="flex items-center gap-2.5">
              <SquarePlus size={16} className="shrink-0 text-brand-ink" />{" "}
              {ios ? tr("dashboard.install_app_ios_step_add") : tr("dashboard.install_app_step_install")}
            </li>
          </ol>
        </Modal>,
        document.querySelector("[data-app-root]") ?? document.body,
      )
    : null;
  return { state, install, dialog };
}

export function InstallAppButton() {
  const { state, install, dialog } = useInstallApp();
  if (state === "none" || state === "manual") return null;
  const label = tr("dashboard.install_app");
  return (
    <>
      <button
        type="button"
        onClick={install}
        aria-label={label}
        title={tr("dashboard.install_app_hint")}
        className="flex h-9 shrink-0 items-center gap-1.5 rounded-lg px-2 text-sm font-medium text-neutral-600 transition hover:bg-neutral-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-400 sm:px-2.5"
      >
        <MonitorDown size={18} />
        <span className="hidden lg:inline">{label}</span>
      </button>
      {dialog}
    </>
  );
}
