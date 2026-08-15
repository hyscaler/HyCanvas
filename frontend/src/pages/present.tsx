// Audience display for the second-display presenter view (doc 28 FR-15).
//
// Opened by the presenter as a separate window (usually dragged to the
// projector). It loads the design itself and mirrors the presenter's slide over
// a BroadcastChannel, so nothing but a slide index crosses the wire. The
// presenter's HUD, notes, laser, and controls live in the primary window; this
// surface shows the audience nothing but the slide (and B/W blanking).
//
// Route: /present/<designId>/?slide=N (the Go server rewrites the pretty path,
// exactly like /editor/<id>; ?id= also works for parity with the editor).

import { useState } from "react";
import Head from "next/head";
import dynamic from "next/dynamic";
import { RequireAuth } from "@/components/RequireAuth";
import { tr } from "@/lib/i18n";

const AudienceStage = dynamic(() => import("@/components/editor/AudienceStage").then((m) => m.AudienceStage), {
  ssr: false,
  loading: () => <div className="grid min-h-screen place-items-center bg-black text-sm text-neutral-500">{tr("page.loading")}</div>,
});

/** The design id, path-style (/present/<id>/) or legacy query (?id=). */
function designIdFromLocation(): string {
  if (typeof window === "undefined") return "";
  const m = /^\/present\/([^/?#]+)\/?$/.exec(window.location.pathname);
  if (m) return decodeURIComponent(m[1]);
  return new URLSearchParams(window.location.search).get("id") ?? "";
}

/** The slide the presenter opened us on (?slide=N). */
function initialSlideFromLocation(): number {
  if (typeof window === "undefined") return 0;
  return Number(new URLSearchParams(window.location.search).get("slide") ?? 0) || 0;
}

export default function PresentPage() {
  // Lazy initializers: this route is client-rendered (the audience window is
  // opened by the presenter), and reading location during the static prerender
  // must not throw. Avoids a setState-in-effect and a ref read during render.
  const [designId] = useState(() => designIdFromLocation());
  const [initialSlide] = useState(() => initialSlideFromLocation());

  return (
    <>
      <Head>
        <title>{tr("page.presenting_hycanvas")}</title>
      </Head>
      <RequireAuth>
        {designId ? (
          <AudienceStage designId={designId} initialSlide={initialSlide} />
        ) : (
          <div className="grid min-h-screen place-items-center bg-black text-sm text-neutral-500">
            {tr("page.no_design_to_present")}
          </div>
        )}
      </RequireAuth>
    </>
  );
}
