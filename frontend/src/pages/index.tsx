// Entry point: resolves the session client-side and routes to the dashboard
// (authed) or the sign-in page (anonymous). Static-export compatible.

import { useEffect } from "react";
import Head from "next/head";
import { useRouter } from "next/router";
import { useAuth } from "@/store/auth";
import { FullScreenLoader } from "@/components/ui/BrandLoader";
import { tr } from "@/lib/i18n";

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
        <title>{tr("page.hycanvas_2")}</title>
        <meta name="description" content={tr("page.a_free_ai_native_visual_design_platform")} />
      </Head>
      <FullScreenLoader label={tr("page.hycanvas")} />
    </>
  );
}
