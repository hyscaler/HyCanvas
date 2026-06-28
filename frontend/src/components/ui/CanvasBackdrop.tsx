// Shared "artist's-desk" decorative backdrop: a faded canvas dot grid, soft
// gradient blobs, and scattered hand-drawn art illustrations (inline SVG -
// graphite "pencil" line work with brand-colored accents). Purely decorative
// (aria-hidden, pointer-events-none); the global prefers-reduced-motion guard
// freezes the float. Used behind the accept-invite card and the sign-in form so
// onboarding feels cohesive. Render inside a `relative overflow-hidden` parent;
// it positions absolutely to fill it.
import { type ReactNode } from "react";

// A slow-floating element. Reuses the app's oc-float keyframe.
function Float({
  className,
  delay = 0,
  duration = 6,
  shadow = false,
  children,
}: {
  className: string;
  delay?: number;
  duration?: number;
  shadow?: boolean;
  children: ReactNode;
}) {
  return (
    <div
      className={`oc-float absolute ${shadow ? "drop-shadow-[0_8px_16px_rgba(15,23,42,0.12)]" : ""} ${className}`}
      style={{ animationDelay: `${delay}s`, animationDuration: `${duration}s` }}
    >
      {children}
    </div>
  );
}

function ArtPencil() {
  return (
    <svg width="74" height="74" viewBox="0 0 74 74" fill="none">
      <path d="M14 54 L44 24 L58 12 L50 28 L20 60 Z" fill="#fff" stroke="#9aa1ad" strokeWidth="2.4" strokeLinejoin="round" />
      <path d="M44 24 L50 28" stroke="#9aa1ad" strokeWidth="2.2" />
      <path d="M14 54 L20 60" stroke="#f59e0b" strokeWidth="4" strokeLinecap="round" />
      <path d="M54 16 L60 20" style={{ stroke: "var(--color-brand-500)" }} strokeWidth="3.2" strokeLinecap="round" />
    </svg>
  );
}

function ArtBrush() {
  return (
    <svg width="70" height="80" viewBox="0 0 70 80" fill="none">
      <path d="M8 10 L30 32" stroke="#9aa1ad" strokeWidth="5" strokeLinecap="round" />
      <rect x="27.5" y="27.5" width="13" height="13" rx="2" transform="rotate(45 34 34)" fill="#fff" stroke="#9aa1ad" strokeWidth="2.2" />
      <path d="M33 37 C45 47 47 53 45 58 C39 54 35 51 29 45 Z" style={{ fill: "var(--color-brand-500)" }} />
      <path d="M28 64 C39 69 52 64 62 72" style={{ stroke: "var(--color-accent-500)" }} strokeWidth="4" strokeLinecap="round" fill="none" />
    </svg>
  );
}

function ArtPalette() {
  return (
    <svg width="86" height="70" viewBox="0 0 86 70" fill="none">
      <path
        d="M43 6 C67 6 81 20 81 36 C81 50 69 57 59 54 C53 52 53 61 45 63 C21 67 5 51 5 33 C5 16 21 6 43 6 Z"
        fill="#fff"
        stroke="#9aa1ad"
        strokeWidth="2.4"
      />
      <circle cx="35" cy="48" r="6" fill="#fff" stroke="#9aa1ad" strokeWidth="2.2" />
      <circle cx="27" cy="24" r="5" style={{ fill: "var(--color-brand-500)" }} />
      <circle cx="45" cy="19" r="5" style={{ fill: "var(--color-accent-500)" }} />
      <circle cx="61" cy="25" r="5" fill="#ec4899" />
      <circle cx="60" cy="41" r="5" fill="#f59e0b" />
    </svg>
  );
}

function ArtSplash() {
  return (
    <svg width="72" height="66" viewBox="0 0 72 66" fill="none">
      <path
        d="M31 5 C41 1 53 7 55 18 C57 28 65 30 66 41 C67 52 56 62 44 62 C32 62 24 56 16 49 C7 41 3 30 8 20 C12 11 21 9 31 5 Z"
        fill="#ec4899"
        opacity="0.45"
      />
    </svg>
  );
}

function ArtStar({ color = "#f59e0b" }: { color?: string }) {
  return (
    <svg width="26" height="26" viewBox="0 0 28 28" fill="none">
      <path d="M14 2 C15 9 19 13 26 14 C19 15 15 19 14 26 C13 19 9 15 2 14 C9 13 13 9 14 2 Z" style={{ fill: color }} />
    </svg>
  );
}

function ArtSquiggle() {
  return (
    <svg width="98" height="22" viewBox="0 0 98 22" fill="none">
      <path d="M4 13 Q15 1 25 11 T47 11 T69 11 T93 11" style={{ stroke: "var(--color-brand-500)" }} strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

function ArtEasel() {
  return (
    <svg width="96" height="108" viewBox="0 0 96 108" fill="none" stroke="#9aa1ad" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M16 100 L48 8 L80 100" />
      <path d="M48 64 L48 104" />
      <rect x="18" y="18" width="60" height="48" rx="2" fill="#fff" />
      <circle cx="62" cy="32" r="5" fill="#f59e0b" stroke="none" />
      <path d="M24 58 Q40 40 52 52 T74 54" style={{ stroke: "var(--color-brand-500)" }} strokeWidth="2.4" fill="none" />
      <path d="M20 66 L76 66" />
    </svg>
  );
}

function ArtScissors() {
  return (
    <svg width="60" height="68" viewBox="0 0 60 68" fill="none" stroke="#9aa1ad" strokeWidth="2.6" strokeLinecap="round">
      <path d="M11 57 L46 18" />
      <path d="M49 57 L14 18" />
      <circle cx="9" cy="59" r="7" />
      <circle cx="51" cy="59" r="7" />
      <circle cx="30" cy="37" r="2.2" fill="#9aa1ad" />
    </svg>
  );
}

function ArtCrayon() {
  return (
    <svg width="40" height="78" viewBox="0 0 40 78" fill="none">
      <path d="M12 22 L20 6 L28 22 Z" fill="#059669" />
      <path d="M12 22 L12 70 Q12 73 15 73 L25 73 Q28 73 28 70 L28 22 Z" fill="#10b981" stroke="#9aa1ad" strokeWidth="2.2" strokeLinejoin="round" />
      <path d="M12 31 L28 31 M12 38 L28 38" stroke="#fff" strokeWidth="2" />
    </svg>
  );
}

function ArtRuler() {
  return (
    <svg width="80" height="68" viewBox="0 0 80 68" fill="none">
      <path d="M9 58 L71 58 L9 10 Z" fill="#fff" stroke="#9aa1ad" strokeWidth="2.4" strokeLinejoin="round" />
      <path d="M19 58 L19 52 M29 58 L29 52 M39 58 L39 52 M49 58 L49 52 M59 58 L59 52" stroke="#9aa1ad" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function ArtMarker() {
  return (
    <svg width="42" height="78" viewBox="0 0 42 78" fill="none">
      <path d="M14 24 L21 8 L28 24 Z" style={{ fill: "var(--color-brand-500)" }} />
      <rect x="12" y="24" width="18" height="44" rx="4" fill="#ec4899" stroke="#9aa1ad" strokeWidth="2.2" />
      <path d="M12 34 L30 34 M12 60 L30 60" stroke="#9aa1ad" strokeWidth="2" />
    </svg>
  );
}

function ArtHeart() {
  return (
    <svg width="26" height="24" viewBox="0 0 26 24" fill="none">
      <path d="M13 22 C2 13 4 4 9 4 C12 4 13 7 13 8 C13 7 14 4 17 4 C22 4 24 13 13 22 Z" fill="#ec4899" />
    </svg>
  );
}

// Steaming coffee cup (artist's-desk realism).
function ArtCoffee() {
  return (
    <svg width="60" height="66" viewBox="0 0 60 66" fill="none">
      <path d="M23 5 Q19 11 23 16 Q27 21 23 26" stroke="#cbd5e1" strokeWidth="2.4" strokeLinecap="round" />
      <path d="M34 5 Q30 11 34 16 Q38 21 34 26" stroke="#cbd5e1" strokeWidth="2.4" strokeLinecap="round" />
      <path d="M12 30 L47 30 L44 58 Q43.5 62 39.5 62 L19.5 62 Q15.5 62 15 58 Z" fill="#fff" stroke="#9aa1ad" strokeWidth="2.4" strokeLinejoin="round" />
      <path d="M47 36 Q58 36 58 45 Q58 54 47 52" stroke="#9aa1ad" strokeWidth="2.4" />
      <ellipse cx="29.5" cy="34" rx="14" ry="3.4" fill="#8b5e34" />
    </svg>
  );
}

// Sticky note with a folded corner + ruled lines.
function ArtNote({ bg, fold, line }: { bg: string; fold: string; line: string }) {
  return (
    <svg width="58" height="56" viewBox="0 0 58 56" fill="none">
      <path d="M5 5 H53 V40 L40 53 H5 Z" fill={bg} />
      <path d="M53 40 H40 V53 Z" fill={fold} />
      <path d="M13 17 H45 M13 25 H40 M13 33 H44" stroke={line} strokeWidth="2" strokeLinecap="round" opacity="0.5" />
    </svg>
  );
}

/** The decorative scene. `compact` shows a lighter subset (e.g. behind the
 *  narrower sign-in form); the full scene is the wide accept-invite backdrop. */
export function CanvasBackdrop({ compact = false }: { compact?: boolean }) {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
      {/* gradient blobs */}
      <div className="absolute -left-32 -top-32 h-96 w-96 rounded-full bg-brand-400/30 blur-3xl" />
      <div className="absolute -bottom-32 -right-24 h-[28rem] w-[28rem] rounded-full bg-accent-400/25 blur-3xl" />
      <div className="absolute left-1/2 top-1/4 h-80 w-80 -translate-x-1/2 rounded-full bg-fuchsia-300/20 blur-3xl" />

      {/* canvas dot grid, faded toward the edges */}
      <div
        className="absolute inset-0"
        style={{
          backgroundImage: "radial-gradient(color-mix(in srgb, var(--color-brand-600) 12%, transparent) 1px, transparent 1px)",
          backgroundSize: "26px 26px",
          maskImage: "radial-gradient(ellipse 62% 62% at 50% 45%, black 0%, transparent 80%)",
          WebkitMaskImage: "radial-gradient(ellipse 62% 62% at 50% 45%, black 0%, transparent 80%)",
        }}
      />

      {/* light scatter (always shown) */}
      <Float className="left-[11%] top-[16%] -rotate-12" duration={7} shadow>
        <ArtPencil />
      </Float>
      <Float className="right-[10%] top-[12%] rotate-12 hidden sm:block" delay={1.1} duration={8} shadow>
        <ArtBrush />
      </Float>
      <Float className="left-[13%] bottom-[14%] -rotate-6" delay={0.6} duration={9} shadow>
        <ArtPalette />
      </Float>
      <Float className="right-[9%] bottom-[16%] rotate-6 hidden sm:block" delay={1.5} duration={8.5}>
        <ArtSplash />
      </Float>
      <Float className="left-[7%] top-[46%] hidden sm:block" delay={0.9} duration={7.5}>
        <ArtSquiggle />
      </Float>
      <Float className="right-[16%] top-[40%] hidden sm:block" delay={1.3} duration={8}>
        <ArtStar color="var(--color-brand-500)" />
      </Float>
      <Float className="left-[28%] top-[7%]" delay={0.3} duration={6.5}>
        <ArtStar />
      </Float>
      <Float className="right-[26%] bottom-[26%]" delay={1.9} duration={7}>
        <ArtStar color="var(--color-accent-500)" />
      </Float>

      {/* richer artist's-desk props (full scene on large screens) */}
      {!compact && (
        <>
          <Float className="left-[5%] top-[54%] -rotate-6 hidden lg:block" delay={0.5} duration={9} shadow>
            <ArtEasel />
          </Float>
          <Float className="right-[6%] top-[56%] rotate-6 hidden lg:block" delay={1.2} duration={8} shadow>
            <ArtScissors />
          </Float>
          <Float className="left-[21%] bottom-[12%] rotate-12 hidden lg:block" delay={0.8} duration={7.5} shadow>
            <ArtCrayon />
          </Float>
          <Float className="right-[19%] bottom-[14%] -rotate-6 hidden lg:block" delay={1.6} duration={8.5} shadow>
            <ArtRuler />
          </Float>
          <Float className="left-[19%] top-[32%] -rotate-12 hidden lg:block" delay={1.0} duration={8} shadow>
            <ArtMarker />
          </Float>
          <Float className="right-[12%] top-[60%] hidden sm:block" delay={0.7} duration={6.5}>
            <ArtHeart />
          </Float>
          <Float className="left-[24%] bottom-[30%] rotate-6 hidden lg:block" delay={1.4} duration={9} shadow>
            <ArtCoffee />
          </Float>
          <Float className="right-[23%] top-[14%] rotate-6 hidden lg:block" delay={0.4} duration={8} shadow>
            <ArtNote bg="#fef08a" fold="#fde047" line="#ca8a04" />
          </Float>
          <Float className="left-[30%] bottom-[10%] -rotate-6 hidden lg:block" delay={1.7} duration={7.5} shadow>
            <ArtNote bg="#fbcfe8" fold="#f9a8d4" line="#db2777" />
          </Float>
        </>
      )}
    </div>
  );
}

/** A tight, contained art cluster for the dashboard hero's right edge. Floats
 *  the lighter props and fades into the gradient toward the headline (left). */
export function HeroArt() {
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-y-0 right-0 hidden w-[22rem] overflow-hidden md:block"
      style={{
        maskImage: "linear-gradient(to right, transparent 0%, black 42%)",
        WebkitMaskImage: "linear-gradient(to right, transparent 0%, black 42%)",
      }}
    >
      <Float className="right-[8%] top-[16%] -rotate-12" duration={7} shadow>
        <ArtPalette />
      </Float>
      <Float className="right-[34%] top-[40%] rotate-6" delay={0.6} duration={8} shadow>
        <ArtBrush />
      </Float>
      <Float className="right-[12%] bottom-[14%] rotate-6" delay={1.0} duration={7.5} shadow>
        <ArtPencil />
      </Float>
      <Float className="right-[44%] top-[14%]" delay={0.3} duration={6.5}>
        <ArtStar color="var(--color-brand-500)" />
      </Float>
      <Float className="right-[5%] top-[54%]" delay={1.4} duration={7}>
        <ArtStar />
      </Float>
      <Float className="right-[52%] bottom-[24%]" delay={0.9} duration={6.5}>
        <ArtHeart />
      </Float>
    </div>
  );
}

/** Bottom backdrop for the dashboard left rail: a soft brand glow that rises
 *  from the floor to ~60% of the rail and fades out, with a little easel-and-
 *  stars motif clustered along the bottom. Absolutely positioned (out of the
 *  flex flow, pointer-events-none) so it never affects layout, scroll, or clicks;
 *  the rail it lives in must be `relative`. */
export function RailArt() {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-3/5 overflow-hidden">
      {/* glow rising to ~60%, fading to transparent at the top */}
      <div className="absolute inset-0 bg-gradient-to-t from-brand-50/80 via-brand-50/20 to-transparent" />
      {/* faint canvas dots concentrated near the floor */}
      <div
        className="absolute inset-0"
        style={{
          backgroundImage: "radial-gradient(color-mix(in srgb, var(--color-brand-500) 11%, transparent) 1px, transparent 1px)",
          backgroundSize: "20px 20px",
          maskImage: "linear-gradient(to top, black 30%, transparent 92%)",
          WebkitMaskImage: "linear-gradient(to top, black 30%, transparent 92%)",
        }}
      />

      {/* grounded still-life: easel centerpiece flanked by palette + brush,
          with a few small sparkles clustered around it like creative sparks.
          The glow + dots above carry the height; objects stay a tight scene. */}
      <Float className="left-12 bottom-40" delay={0.3} duration={6.5}>
        <ArtStar color="var(--color-brand-500)" />
      </Float>
      <Float className="left-1/2 bottom-[13rem] -translate-x-1/2" delay={1.0} duration={7}>
        <ArtStar color="#f59e0b" />
      </Float>
      <Float className="right-14 bottom-44" delay={0.7} duration={7.5}>
        <ArtStar color="var(--color-accent-500)" />
      </Float>
      <Float className="left-2 bottom-20 -rotate-6" delay={0.6} duration={9} shadow>
        <ArtPalette />
      </Float>
      <Float className="right-3 bottom-24 rotate-6" delay={1.3} duration={8} shadow>
        <ArtBrush />
      </Float>
      <Float className="left-1/2 bottom-1 -translate-x-1/2 -rotate-3" duration={8} shadow>
        <ArtEasel />
      </Float>
    </div>
  );
}

/** A small centered still-life for empty panels (no designs / no favorites). */
export function EmptyArt() {
  return (
    <div aria-hidden className="mb-5 flex items-end justify-center gap-2 opacity-95">
      <div className="-rotate-6">
        <ArtPalette />
      </div>
      <div className="rotate-2">
        <ArtEasel />
      </div>
      <div className="rotate-6">
        <ArtBrush />
      </div>
    </div>
  );
}
