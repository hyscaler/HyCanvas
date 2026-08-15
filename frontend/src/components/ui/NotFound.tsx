// Shared branded "not found" screen. Used by the 404 route (pages/404.tsx) and
// by the editor when a design id does not exist, so both read identically: the
// ambient brand art, the logo, a large gradient code, a title + message, and
// "back" actions.

import { useRouter } from "next/router";
import { Button } from "@/components/ui/Button";
import { Logo } from "@/components/ui/Logo";
import { CanvasFloor } from "@/components/ui/CanvasFloor";
import { tr } from "@/lib/i18n";

export function NotFoundScreen({
  code = "404",
  title = tr("ui.page_not_found"),
  message = tr("ui.the_page_you_are_looking_for_does_not_exist"),
  homeLabel = tr("ui.back_to_home"),
  homeHref = "/",
}: {
  code?: string;
  title?: string;
  message?: string;
  homeLabel?: string;
  homeHref?: string;
}) {
  const router = useRouter();
  return (
    <div className="relative grid min-h-screen place-items-center overflow-hidden px-6 text-center text-white">
      <CanvasFloor />
      <div className="relative z-10 flex flex-col items-center gap-6">
        <Logo variant="light" size={34} />
        <div>
          {/* Lighter half of the brand scale: the standard gradient's deep
              start is near-invisible on the ink floor. */}
          <p className="bg-gradient-to-br from-brand-300 via-brand-400 to-accent-300 bg-clip-text text-transparent text-7xl font-extrabold tracking-tight sm:text-8xl">{code}</p>
          <h1 className="mt-3 text-2xl font-bold tracking-tight">{title}</h1>
          <p className="mx-auto mt-2 max-w-md text-sm text-white/60">{message}</p>
        </div>
        <div className="flex flex-wrap items-center justify-center gap-3">
          <Button onClick={() => void router.push(homeHref)}>{homeLabel}</Button>
          <Button variant="secondary" onClick={() => router.back()}>{tr("ui.go_back")}</Button>
        </div>
      </div>
    </div>
  );
}
