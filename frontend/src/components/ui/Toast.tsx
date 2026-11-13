// Lightweight toast system: a provider + useToast() hook + a fixed toaster.
// Replaces alert()/silent failures with branded, auto-dismissing notifications.

import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { CheckCircle2, AlertCircle, Info, X } from "lucide-react";
import { cn } from "@/lib/cn";
import { tr } from "@/lib/i18n";

type ToastKind = "success" | "error" | "info";
interface ToastAction {
  label: string;
  onClick: () => void;
}

interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
  action?: ToastAction;
}

export interface ToastOptions {
  kind?: ToastKind;
  /** A single button next to the message; clicking it also dismisses. */
  action?: ToastAction;
  /** Milliseconds before auto-dismiss; 0 keeps it until dismissed. */
  duration?: number;
}

interface ToastApi {
  toast: (message: string, kind?: ToastKind) => void;
  success: (message: string) => void;
  error: (message: string) => void;
  /** A toast with options (an action, or one that stays). Returns a dismiss. */
  show: (message: string, options?: ToastOptions) => () => void;
}

const ToastContext = createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within <ToastProvider>");
  return ctx;
}

const ICONS = { success: CheckCircle2, error: AlertCircle, info: Info } as const;
const TONE = {
  success: "text-emerald-600",
  error: "text-red-600",
  info: "text-brand-ink",
} as const;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seq = useRef(0);

  const remove = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);

  const show = useCallback(
    (message: string, { kind = "info", action, duration = 4000 }: ToastOptions = {}) => {
      const id = ++seq.current;
      setToasts((t) => [...t, { id, kind, message, action }]);
      if (duration > 0) setTimeout(() => remove(id), duration);
      return () => remove(id);
    },
    [remove],
  );

  const toast = useCallback(
    (message: string, kind: ToastKind = "info") => {
      show(message, { kind });
    },
    [show],
  );

  // Stable identity: `toast` is a useCallback, so memoizing here keeps the whole
  // api object stable across provider re-renders (e.g. when a toast is added or
  // auto-dismissed). Without this, every consumer that lists `toast` in an effect
  // dependency array re-runs the effect on each toast change - which turns a
  // failing fetch-on-mount (the catch calls toast.error) into an infinite
  // request loop.
  const api = useMemo<ToastApi>(
    () => ({
      toast,
      success: (m) => toast(m, "success"),
      error: (m) => toast(m, "error"),
      show,
    }),
    [toast, show],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div
        role="status"
        aria-live="polite"
        // --oc-toast-lift lets a screen with its own bottom bar (the editor's
        // phone tab bar) raise toasts above it instead of covering it.
        className="pointer-events-none fixed bottom-[calc(1rem+var(--oc-toast-lift,0px))] end-4 z-[100] flex flex-col gap-2"
      >
        {toasts.map((t) => {
          const Icon = ICONS[t.kind];
          const isError = t.kind === "error";
          return (
            <div
              key={t.id}
              role={isError ? "alert" : "status"}
              aria-live={isError ? "assertive" : "polite"}
              className="pointer-events-auto flex w-[min(20rem,calc(100vw-2rem))] items-start gap-2.5 rounded-xl border border-neutral-200 bg-surface px-3.5 py-3 text-sm shadow-lg"
            >
              <Icon size={18} className={cn("mt-0.5 shrink-0", TONE[t.kind])} />
              <span className="flex-1 text-neutral-800">{t.message}</span>
              {t.action && (
                <button
                  onClick={() => {
                    remove(t.id);
                    t.action?.onClick();
                  }}
                  className="shrink-0 rounded font-semibold text-brand-ink hover:underline"
                >
                  {t.action.label}
                </button>
              )}
              <button onClick={() => remove(t.id)} className="text-neutral-400 hover:text-neutral-700" aria-label={tr("ui.dismiss")}>
                <X size={15} />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}
