// Square icon-only button used in toolbars and rails. `active` highlights the
// current tool. Pass `tooltip` to show a styled label on hover/focus (a nicer,
// instant alternative to the native `title` bubble); without it the button
// renders bare, exactly as before.

import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/cn";

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  active?: boolean;
  size?: "sm" | "md";
  /** Styled tooltip label shown on hover/keyboard focus. */
  tooltip?: string;
  /** Side the tooltip appears on (default "bottom"). */
  tooltipSide?: "top" | "bottom";
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  {
    className,
    active,
    size = "md",
    type = "button",
    tooltip,
    tooltipSide = "bottom",
    title,
    "aria-label": ariaLabel,
    ...props
  },
  ref,
) {
  const button = (
    <button
      ref={ref}
      type={type}
      // With a styled tooltip we skip the native title (avoids a double bubble);
      // the label still names the control for assistive tech via aria-label.
      title={tooltip ? undefined : title}
      aria-label={ariaLabel ?? tooltip}
      className={cn(
        "inline-grid place-items-center rounded-lg text-neutral-600 transition hover:bg-neutral-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-400 disabled:opacity-40",
        size === "sm" ? "h-8 w-8" : "h-9 w-9",
        active && "bg-brand-50 text-brand-ink hover:bg-brand-50",
        className,
      )}
      {...props}
    />
  );

  if (!tooltip) return button;

  return (
    <span className="group/tt relative inline-flex">
      {button}
      <span
        role="tooltip"
        className={cn(
          // text-surface, not text-white: neutral-900 flips light in dark mode,
          // so the label must flip with it to stay readable.
          "pointer-events-none absolute left-1/2 z-50 -translate-x-1/2 scale-95 whitespace-nowrap rounded-md bg-neutral-900 px-2 py-1 text-xs font-medium text-surface opacity-0 shadow-lg transition duration-100 group-hover/tt:scale-100 group-hover/tt:opacity-100 group-focus-within/tt:scale-100 group-focus-within/tt:opacity-100",
          tooltipSide === "bottom" ? "top-full mt-1.5" : "bottom-full mb-1.5",
        )}
      >
        {tooltip}
      </span>
    </span>
  );
});
