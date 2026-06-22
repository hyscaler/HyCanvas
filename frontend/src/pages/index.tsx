// Entry point: resolves the session client-side and routes to the dashboard
// (authed) or the sign-in page (anonymous). Static-export compatible.

import { useEffect } from "react";
import Head from "next/head";
import { useRouter } from "next/router";
import { useAuth } from "@/store/auth";

export default function Home() {
  const router = useRouter();
  const status = useAuth((s) => s.status);
  const bootstrap = useAuth((s) => s.bootstrap);

  useEffect(() => {
    if (status === "loading") void bootstrap();
  }, [status, bootstrap]);

  useEffect(() => {
    if (status === "authed") void router.replace("/dashboard");
    else if (status === "anon") void router.replace("/login");
  }, [status, router]);

  return (
    <>
      <Head>
        <title>HyCanvas</title>
        <meta name="description" content="A free, AI-native visual design platform." />
      </Head>
      <div className="grid min-h-screen place-items-center text-sm text-neutral-500">HyCanvas…</div>
    </>
  );
}
