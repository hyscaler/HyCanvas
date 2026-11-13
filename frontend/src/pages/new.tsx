import Head from "next/head";
import { useEffect, useRef } from "react";
import { useRouter } from "next/router";
import { createBlankDesign } from "@hc/schema";
import { RequireAuth } from "@/components/RequireAuth";
import { FullScreenLoader } from "@/components/ui/BrandLoader";
import { useToast } from "@/components/ui/Toast";
import { useAuth } from "@/store/auth";
import { oc } from "@/lib/sdk";
import { tr } from "@/lib/i18n";
import { VIEWPORT } from "@/lib/viewport";

// /new/?kind=design|presentation|whiteboard creates a blank document in the
// active workspace and opens it in the editor. It is the target of the install
// manifest's shortcuts (long-press the home screen icon), so it has to work as
// a cold start: RequireAuth bootstraps the session first, and any failure lands
// on the dashboard rather than a dead end.

type Kind = "design" | "presentation" | "whiteboard";

// The same formats the dashboard's create menu uses for these three types.
const FORMATS: Record<Kind, { w: number; h: number; label: () => string; metaKind?: string }> = {
  design: { w: 1080, h: 1080, label: () => tr("dashboard.untitled_design") },
  presentation: { w: 1920, h: 1080, label: () => tr("dashboard.presentation") },
  whiteboard: { w: 1920, h: 1080, label: () => tr("dashboard.whiteboard"), metaKind: "whiteboard" },
};

function CreateAndOpen() {
  const router = useRouter();
  const workspaceId = useAuth((s) => s.activeWorkspaceId);
  const toast = useToast();
  const started = useRef(false);

  useEffect(() => {
    if (!router.isReady || started.current) return;
    if (!workspaceId) {
      void router.replace("/dashboard/");
      return;
    }
    started.current = true;
    const raw = typeof router.query.kind === "string" ? router.query.kind : "design";
    const fmt = FORMATS[(raw in FORMATS ? raw : "design") as Kind];
    void (async () => {
      try {
        const title = fmt.label();
        const from = createBlankDesign({ title, width: fmt.w, height: fmt.h });
        if (fmt.metaKind) from.meta.kind = fmt.metaKind;
        const rec = await oc.createDesign({ workspaceId, title, from });
        void router.replace({ pathname: "/editor", query: { id: rec.id } });
      } catch {
        toast.error(tr("dashboard.could_not_create_design"));
        void router.replace("/dashboard/");
      }
    })();
  }, [router, workspaceId, toast]);

  return <FullScreenLoader />;
}

export default function NewDesignPage() {
  return (
    <>
      <Head>
        <meta key="viewport" name="viewport" content={VIEWPORT} />
        <title>{`${tr("dashboard.untitled_design")} · HyCanvas`}</title>
      </Head>
      <RequireAuth>
        <CreateAndOpen />
      </RequireAuth>
    </>
  );
}
