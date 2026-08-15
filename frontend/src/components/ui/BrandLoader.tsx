import { tr } from "@/lib/i18n";
// Brand loading state: the animated visitor mark (brand asset
// /brand/visitor-loader.svg; the cursor arrives, the stroke paints itself and
// escapes, on a 2.8s loop, resting complete under prefers-reduced-motion).
// The SVG's CSS animation runs fine inside an <img>, keeping the asset the
// single source of truth shared with the marketing site.

export function BrandLoader({ size = 104, label }: { size?: number; label?: string }) {
  return (
    <span className="inline-flex flex-col items-center gap-3">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/brand/visitor-loader.svg" width={size} height={size * (50 / 52)} alt="" aria-hidden />
      <span role="status" className="text-sm text-neutral-500">
        {label ?? tr("ui.loading")}
      </span>
    </span>
  );
}

/** Full-viewport centered loader for app boot / auth resolution. */
export function FullScreenLoader({ label }: { label?: string }) {
  return (
    <div className="grid min-h-screen place-items-center bg-neutral-50">
      <BrandLoader label={label} />
    </div>
  );
}
