// Brand logo: "the visitor" mark (hycanvas-marketing/brand): a two-legged
// easel holding a selected, tilted canvas with a painted stroke escaping the
// frame and a collaborator cursor flying in. Single-color monocon (strokes
// 3.2 / 1.6), drawn with currentColor so it recolors per surface. Brand rules:
// on the gradient the mark is always paper, on paper always ink; static copies
// of the masters live in /public/brand for non-React surfaces.

import { cn } from "@/lib/cn";

// The brand's "paper" tone (mark color on gradient/dark surfaces). Part of the
// logo asset itself, not the app accent system.
const PAPER = "#FBF7FA";

/** The bare visitor mark, in currentColor. viewBox is 52x50. */
export function VisitorMark({ size = 20, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size * 1.04}
      height={size}
      viewBox="0 0 52 50"
      fill="none"
      aria-hidden="true"
      className={className}
    >
      <path d="M15.5 3L14.5 7M20.5 3L21.8 7" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" />
      <path d="M7 40.5L5 48M32.6 40.5L35 48" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" />
      <g transform="rotate(-5 19 24)">
        <rect x="7.5" y="10.5" width="23" height="25" stroke="currentColor" strokeWidth="3.2" />
        <rect x="4.7" y="7.7" width="28.6" height="30.6" stroke="currentColor" strokeWidth="1.6" />
        <g fill="currentColor">
          <rect x="3" y="6" width="3.4" height="3.4" rx=".8" />
          <rect x="31.6" y="6" width="3.4" height="3.4" rx=".8" />
          <rect x="3" y="36.6" width="3.4" height="3.4" rx=".8" />
          <rect x="31.6" y="36.6" width="3.4" height="3.4" rx=".8" />
        </g>
      </g>
      <path d="M12 30.5C16.5 24.5 22 23.5 26.5 18.5 29.5 15.2 32.5 12.2 36 9.8" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" />
      <circle cx="38.8" cy="7.6" r="1.5" fill="currentColor" />
      <circle cx="41.4" cy="5" r="1" fill="currentColor" />
      <path transform="translate(38.5,31) scale(0.64)" d="M4 2l16 8-7 2-2 7z" fill="currentColor" />
      <path d="M38.2 30.8l-2.2-1.8M40.8 28.4l-1.7-2.2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

export function LogoMark({ size = 32, variant = "gradient" }: { size?: number; variant?: "gradient" | "light" }) {
  return (
    <span
      className={cn("inline-grid shrink-0 place-items-center", variant === "gradient" ? "oc-gradient" : "bg-white/20")}
      // The official tile radius is 22% of the tile edge.
      style={{ width: size, height: size, borderRadius: Math.round(size * 0.22), color: PAPER }}
    >
      <VisitorMark size={size * 0.62} />
    </span>
  );
}

export function Logo({
  size = 32,
  variant = "gradient",
  className,
}: {
  size?: number;
  variant?: "gradient" | "light";
  className?: string;
}) {
  return (
    <span className={cn("flex items-center gap-2.5 text-lg font-extrabold tracking-tight", className)}>
      <LogoMark size={size} variant={variant} />
      {variant === "light" ? <span className="text-white">HyCanvas</span> : <span className="oc-gradient-text">HyCanvas</span>}
    </span>
  );
}
