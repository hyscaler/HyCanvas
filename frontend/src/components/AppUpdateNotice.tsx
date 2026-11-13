// Registers the service worker on every production load and, when a newer
// build is ready (a self-hoster swapped the binary), shows a toast that stays
// until dismissed with a Reload action. It never reloads on its own: the user
// picks the moment, so unsaved editor work is never lost to an update.
//
// Not rendered under `next dev`, where hot reload owns updates and a caching
// worker would only get in the way.

import { useEffect, useRef } from "react";
import { useToast } from "@/components/ui/Toast";
import { applyUpdate, watchForUpdates } from "@/lib/sw";
import { tr } from "@/lib/i18n";

export function AppUpdateNotice() {
  const { show } = useToast();
  const dismiss = useRef<(() => void) | null>(null);

  useEffect(
    () =>
      watchForUpdates(() => {
        // One notice at a time, however many update events arrive.
        if (dismiss.current) return;
        dismiss.current = show(tr("pwa.update_available"), {
          duration: 0,
          action: {
            label: tr("pwa.reload"),
            onClick: () => {
              dismiss.current = null;
              void applyUpdate();
            },
          },
        });
      }),
    [show],
  );

  return null;
}
