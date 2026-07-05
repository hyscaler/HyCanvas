// The marketing site's "canvas floor", brought into the app: the ink brand
// surface with a design-tool dot grid, two slow ambient plum blobs, and film
// grain. Purely decorative (aria-hidden, pointer-events-none); the global
// prefers-reduced-motion rule freezes the blob drift. Render inside a
// `relative overflow-hidden` parent; it fills it absolutely and sits behind
// content (keep foreground children `relative z-10`).

import { cn } from "@/lib/cn";

export function CanvasFloor({ className }: { className?: string }) {
  return (
    <div aria-hidden className={cn("oc-floor pointer-events-none absolute inset-0 overflow-hidden", className)}>
      <div className="oc-floor-blob oc-floor-blob-a absolute -left-[16%] -top-[18%] h-[60%] w-[60%]" />
      <div className="oc-floor-blob oc-floor-blob-b absolute -bottom-[22%] -right-[18%] h-[60%] w-[60%]" />
      <div className="oc-floor-grid absolute inset-0" />
      <div className="oc-floor-grain absolute inset-0" />
    </div>
  );
}
