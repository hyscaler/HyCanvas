import Head from "next/head";
import dynamic from "next/dynamic";
import { RequireAuth } from "@/components/RequireAuth";

// Client-only: depends on auth state, localStorage, and live API calls.
const DashboardApp = dynamic(() => import("@/components/dashboard/DashboardApp").then((m) => m.DashboardApp), {
  ssr: false,
  loading: () => <div className="grid min-h-screen place-items-center text-sm text-neutral-500">Loading…</div>,
});

export default function DashboardPage() {
  return (
    <>
      <Head>
        <title>Your designs · HyCanvas</title>
      </Head>
      <RequireAuth>
        <DashboardApp />
      </RequireAuth>
    </>
  );
}
