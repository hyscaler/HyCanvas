// Shared branded "not found" screen. Used by the 404 route (pages/404.tsx) and
// by the editor when a design id does not exist, so both read identically: the
// ambient brand art, the logo, a large gradient code, a title + message, and
// "back" actions.

import { useRouter } from "next/router";
import { Button } from "@/components/ui/Button";
import { Logo } from "@/components/ui/Logo";
import { CanvasBackdrop } from "@/components/ui/CanvasBackdrop";

export function NotFoundScreen({
  code = "404",
  title = "Page not found",
  message = "The page you are looking for does not exist or may have moved.",
  homeLabel = "Back to home",
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
    <div className="relative grid min-h-screen place-items-center overflow-hidden bg-neutral-50 px-6 text-center text-neutral-900">
      <CanvasBackdrop />
      <div className="relative flex flex-col items-center gap-6">
        <Logo size={34} />
        <div>
          <p className="oc-gradient-text text-7xl font-extrabold tracking-tight sm:text-8xl">{code}</p>
          <h1 className="mt-3 text-2xl font-bold tracking-tight">{title}</h1>
          <p className="mx-auto mt-2 max-w-md text-sm text-neutral-500">{message}</p>
        </div>
        <div className="flex flex-wrap items-center justify-center gap-3">
          <Button onClick={() => void router.push(homeHref)}>{homeLabel}</Button>
          <Button variant="secondary" onClick={() => router.back()}>Go back</Button>
        </div>
      </div>
    </div>
  );
}
