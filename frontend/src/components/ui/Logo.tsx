// Brand logo. A rounded gradient tile with a clean white 4-point spark mark
// (nods to the "AI-native" identity), plus an optional wordmark. Replaces the
// placeholder glyph used during scaffolding.

import { cn } from "@/lib/cn";

const SPARK = "M16 2 L19.5 12.5 L30 16 L19.5 19.5 L16 30 L12.5 19.5 L2 16 L12.5 12.5 Z";

export function LogoMark({ size = 32, variant = "gradient" }: { size?: number; variant?: "gradient" | "light" }) {
  return (
    <span
      className={cn("inline-grid shrink-0 place-items-center rounded-xl", variant === "gradient" ? "oc-gradient" : "bg-white/20")}
      style={{ width: size, height: size }}
    >
      <svg width={size * 0.6} height={size * 0.6} viewBox="0 0 32 32" fill="none" aria-hidden="true">
        <path d={SPARK} fill="#fff" />
      </svg>
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
