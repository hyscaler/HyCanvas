import "@/styles/globals.css";
import { useEffect } from "react";
import type { AppProps } from "next/app";
import { Plus_Jakarta_Sans } from "next/font/google";
import { ToastProvider } from "@/components/ui/Toast";
import { watchSystemTheme } from "@/lib/theme";
import { applyLocale, getLocalePreference, setLocalePreference } from "@/lib/locale";
import { initI18n, loadCatalog, useI18nVersion } from "@/lib/i18n";
import { useAuth } from "@/store/auth";

// Friendly geometric brand sans, exposed as --font-brand for the design tokens.
const brand = Plus_Jakarta_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800"],
  variable: "--font-brand",
  display: "swap",
});

export default function App({ Component, pageProps }: AppProps) {
  // Follow OS scheme changes live while the preference is "system" (the boot
  // script in _document applied the initial state before first paint).
  useEffect(() => watchSystemTheme(), []);
  // Re-apply on mount so a locale changed in another tab, or a stored value the
  // boot script could not read, still lands.
  useEffect(() => applyLocale(), []);
  // Load the catalog for the active locale. English is bundled, so this is a
  // no-op for most users and never blocks first paint.
  useEffect(() => initI18n(), []);
  // The account already carried a `locale`, but only date formatting read it:
  // picking a language in Settings changed how timestamps looked and nothing
  // else. Adopt it as the device preference so the language, the document's
  // `lang`/`dir`, and the catalog all follow the account, and so the choice
  // survives to the pre-paint boot script on the next load.
  const accountLocale = useAuth((s) => s.user?.locale);
  useEffect(() => {
    if (!accountLocale || accountLocale === getLocalePreference()) return;
    setLocalePreference(accountLocale);
    void loadCatalog(accountLocale);
  }, [accountLocale]);
  // Strings are read through a plain function rather than a hook, so nothing
  // re-renders on its own when the catalog arrives or the language changes.
  // Keying the tree here remounts the app once at that moment, which is the
  // whole cost of not threading a hook through 1500 call sites. Switching
  // language is deliberate and rare, so a remount is the right trade.
  const i18nVersion = useI18nVersion();
  return (
    <div className={`${brand.variable} font-sans`}>
      <ToastProvider>
        <Component key={i18nVersion} {...pageProps} />
      </ToastProvider>
    </div>
  );
}
