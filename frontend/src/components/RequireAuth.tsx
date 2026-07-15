// Client-side route guard. Bootstraps the session on first mount and
// redirects to /login when anonymous. Compatible with static export: all auth
// resolution happens in the browser.

import { useEffect, type ReactNode } from "react";
import { useRouter } from "next/router";
import { useAuth } from "@/store/auth";
import { FullScreenLoader } from "@/components/ui/BrandLoader";

export function RequireAuth({ children }: { children: ReactNode }) {
  const router = useRouter();
  const status = useAuth((s) => s.status);
  const bootstrap = useAuth((s) => s.bootstrap);

  useEffect(() => {
    if (status === "loading") void bootstrap();
  }, [status, bootstrap]);

  useEffect(() => {
    if (status !== "anon") return;
    // Carry the current location as a return path so a deep link (e.g.
    // /dashboard/templates) survives the login round-trip. AuthForm validates
    // `next` as a same-origin relative path before honoring it.
    const path = router.asPath;
    const next = path && path !== "/" ? `?next=${encodeURIComponent(path)}` : "";
    void router.replace(`/login${next}`);
  }, [status, router]);

  if (status !== "authed") {
    return <FullScreenLoader />;
  }
  return <>{children}</>;
}
