import Head from "next/head";
import dynamic from "next/dynamic";
import { RequireAuth } from "@/components/RequireAuth";

// Client-only: depends on auth state and live API calls.
const SettingsApp = dynamic(() => import("@/components/settings/SettingsApp").then((m) => m.SettingsApp), {
  ssr: false,
  loading: () => <div className="grid min-h-screen place-items-center text-sm text-neutral-500">Loading…</div>,
});

export default function SettingsPage() {
  return (
    <>
      <Head>
        <title>Settings · HyCanvas</title>
      </Head>
      <RequireAuth>
        <SettingsApp />
      </RequireAuth>
    </>
  );
}
