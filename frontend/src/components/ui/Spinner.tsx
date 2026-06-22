import { cn } from "@/lib/cn";

export function Spinner({ className }: { className?: string }) {
  return (
    <span
      className={cn("inline-block animate-spin rounded-full border-2 border-neutral-300 border-t-brand-600", className)}
      style={{ width: "1em", height: "1em" }}
      aria-hidden="true"
    />
  );
}
