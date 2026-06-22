// The editor route. The editor owns a live canvas and browser-only APIs, so it
// is loaded client-side only (no SSR), which is compatible with static export.

import dynamic from "next/dynamic";
import Head from "next/head";
import { RequireAuth } from "@/components/RequireAuth";

const EditorApp = dynamic(
  () => import("@/components/editor/EditorApp").then((m) => m.EditorApp),
  { ssr: false, loading: () => <div className="p-6 text-neutral-500">Loading editor…</div> },
);

export default function EditorPage() {
  return (
    <>
      <Head>
        <title>HyCanvas Editor</title>
      </Head>
      <RequireAuth>
        <EditorApp />
      </RequireAuth>
    </>
  );
}
