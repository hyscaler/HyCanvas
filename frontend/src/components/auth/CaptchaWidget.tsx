// CAPTCHA widget for the auth forms, provider-agnostic over Cloudflare Turnstile
// and Google reCAPTCHA. The instance's provider + public site key come from the
// server auth config; this component loads the provider script once, renders the
// widget, and hands the solved token back to the form. A ref lets the form reset
// it after a failed submit, since the token is single-use.

import { useEffect, useImperativeHandle, useRef, forwardRef } from "react";
import type { CaptchaSettings } from "@hc/sdk";

export interface CaptchaHandle {
  reset: () => void;
}

// Minimal shapes of the provider globals we touch (each script defines one).
interface TurnstileApi {
  render: (el: HTMLElement, opts: { sitekey: string; callback: (t: string) => void; "expired-callback"?: () => void; "error-callback"?: () => void }) => string;
  reset: (id?: string) => void;
}
interface RecaptchaApi {
  render: (el: HTMLElement, opts: { sitekey: string; callback: (t: string) => void; "expired-callback"?: () => void; "error-callback"?: () => void }) => number;
  reset: (id?: number) => void;
  ready: (cb: () => void) => void;
}
declare global {
  interface Window {
    turnstile?: TurnstileApi;
    grecaptcha?: RecaptchaApi;
  }
}

const SCRIPTS: Record<CaptchaSettings["provider"], { src: string; global: "turnstile" | "grecaptcha" }> = {
  turnstile: { src: "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit", global: "turnstile" },
  recaptcha: { src: "https://www.google.com/recaptcha/api.js?render=explicit", global: "grecaptcha" },
};

// Load a provider script once (idempotent across mounts) and resolve when its
// global is ready.
function loadScript(provider: CaptchaSettings["provider"]): Promise<void> {
  const { src, global } = SCRIPTS[provider];
  return new Promise((resolve, reject) => {
    if (window[global]) return resolve();
    const existing = document.querySelector<HTMLScriptElement>(`script[data-captcha="${provider}"]`);
    if (existing) {
      existing.addEventListener("load", () => resolve());
      existing.addEventListener("error", () => reject(new Error("captcha script failed")));
      return;
    }
    const s = document.createElement("script");
    s.src = src;
    s.async = true;
    s.defer = true;
    s.dataset.captcha = provider;
    s.addEventListener("load", () => resolve());
    s.addEventListener("error", () => reject(new Error("captcha script failed")));
    document.head.appendChild(s);
  });
}

export const CaptchaWidget = forwardRef<CaptchaHandle, {
  captcha: CaptchaSettings;
  onToken: (token: string | null) => void;
}>(function CaptchaWidget({ captcha, onToken }, ref) {
  const containerRef = useRef<HTMLDivElement>(null);
  // The provider's opaque widget id, needed to reset it.
  const widgetIdRef = useRef<string | number | null>(null);

  useImperativeHandle(ref, () => ({
    reset() {
      onToken(null);
      const id = widgetIdRef.current;
      if (captcha.provider === "turnstile") window.turnstile?.reset(typeof id === "string" ? id : undefined);
      else window.grecaptcha?.reset(typeof id === "number" ? id : undefined);
    },
  }), [captcha.provider, onToken]);

  useEffect(() => {
    let cancelled = false;
    void loadScript(captcha.provider)
      .then(() => {
        if (cancelled || !containerRef.current) return;
        const opts = {
          sitekey: captcha.siteKey,
          callback: (t: string) => onToken(t),
          "expired-callback": () => onToken(null),
          "error-callback": () => onToken(null),
        };
        if (captcha.provider === "turnstile" && window.turnstile) {
          widgetIdRef.current = window.turnstile.render(containerRef.current, opts);
        } else if (captcha.provider === "recaptcha" && window.grecaptcha) {
          window.grecaptcha.ready(() => {
            if (!cancelled && containerRef.current) {
              widgetIdRef.current = window.grecaptcha!.render(containerRef.current, opts);
            }
          });
        }
      })
      .catch(() => { if (!cancelled) onToken(null); });
    return () => { cancelled = true; };
    // Render once per provider/site key; onToken is stable enough for this effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [captcha.provider, captcha.siteKey]);

  return <div ref={containerRef} className="flex justify-center" />;
});
