import "@/styles/globals.css";
import { useEffect } from "react";
import type { AppProps } from "next/app";
import { Plus_Jakarta_Sans } from "next/font/google";
import { ToastProvider } from "@/components/ui/Toast";
import { watchSystemTheme } from "@/lib/theme";

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
  return (
    <div className={`${brand.variable} font-sans`}>
      <ToastProvider>
        <Component {...pageProps} />
      </ToastProvider>
    </div>
  );
}
