// Labeled text input with a focus ring and optional error text.

import { forwardRef, useId, type InputHTMLAttributes } from "react";
import { cn } from "@/lib/cn";

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, label, error, id, ...props },
  ref,
) {
  const autoId = useId();
  const inputId = id ?? autoId;
  return (
    <div className="flex flex-col gap-1.5">
      {label && (
        <label htmlFor={inputId} className="text-sm font-medium text-neutral-700">
          {label}
        </label>
      )}
      <input
        ref={ref}
        id={inputId}
        className={cn(
          "h-11 rounded-xl border border-neutral-200 bg-white px-3.5 text-sm text-neutral-900 placeholder:text-neutral-400 outline-none transition focus:border-brand-500 focus:ring-2 focus:ring-brand-100",
          error && "border-red-400 focus:border-red-500 focus:ring-red-100",
          className,
        )}
        {...props}
      />
      {error && <p className="text-xs text-red-600">{error}</p>}
    </div>
  );
});
