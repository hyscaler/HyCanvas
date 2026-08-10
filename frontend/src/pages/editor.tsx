// The editor route. The editor owns a live canvas and browser-only APIs, so it
// is loaded client-side only (no SSR), which is compatible with static export.

import dynamic from "next/dynamic";
import Head from "next/head";
import { RequireAuth } from "@/components/RequireAuth";
import { tr } from "@/lib/i18n";

const EditorApp = dynamic(
  () => import("@/components/editor/EditorApp").then((m) => m.EditorApp),
  { ssr: false, loading: () => <div className="p-6 text-neutral-500">{tr("page.loading_editor")}</div> },
);

export default function EditorPage() {
  return (
    <>
      <Head>
        <title>{tr("page.hycanvas_editor")}</title>
      </Head>
      <RequireAuth>
        <EditorApp />
      </RequireAuth>
    </>
  );
}
