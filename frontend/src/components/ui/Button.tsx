// Brand button. Primary uses the violet->blue gradient; variants cover the
// common cases. Built on cva so usage stays terse and consistent.

import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/cn";

const button = cva(
  "inline-flex items-center justify-center gap-2 rounded-xl font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-400 focus-visible:ring-offset-1 disabled:cursor-not-allowed disabled:opacity-50",
  {
    variants: {
      variant: {
        primary: "oc-gradient text-white shadow-sm hover:opacity-90 active:opacity-100",
        secondary: "border border-neutral-200 bg-white text-neutral-800 hover:bg-neutral-50",
        ghost: "text-neutral-600 hover:bg-neutral-100",
        danger: "bg-red-600 text-white hover:bg-red-700",
      },
      size: {
        sm: "h-8 px-3 text-sm",
        md: "h-10 px-4 text-sm",
        lg: "h-12 px-6 text-base",
      },
      block: { true: "w-full", false: "" },
    },
    defaultVariants: { variant: "primary", size: "md", block: false },
  },
);

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof button> {}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant, size, block, type = "button", ...props },
  ref,
) {
  return <button ref={ref} type={type} className={cn(button({ variant, size, block }), className)} {...props} />;
});
