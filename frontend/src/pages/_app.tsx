import "@/styles/globals.css";
import type { AppProps } from "next/app";
import { Plus_Jakarta_Sans } from "next/font/google";
import { ToastProvider } from "@/components/ui/Toast";

// Friendly geometric brand sans, exposed as --font-brand for the design tokens.
const brand = Plus_Jakarta_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800"],
  variable: "--font-brand",
  display: "swap",
});

export default function App({ Component, pageProps }: AppProps) {
  return (
    <div className={`${brand.variable} font-sans`}>
      <ToastProvider>
        <Component {...pageProps} />
      </ToastProvider>
    </div>
  );
}
