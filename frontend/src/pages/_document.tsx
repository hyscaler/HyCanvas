import { Html, Head, Main, NextScript } from "next/document";
import { brand } from "@/lib/theme.generated";
import { THEME_BOOT_SCRIPT } from "@/lib/theme";

export default function Document() {
  return (
    <Html lang="en">
      <Head>
        {/* Apply the stored dark-mode preference before first paint (no flash). */}
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }} />
        <meta name="theme-color" content={brand["600"]} />
        {/* The visitor mark (hycanvas-marketing/brand): SVG first, PNG + ICO
            fallbacks, plus the touch/PWA tiles. */}
        <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
        <link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png" />
        <link rel="icon" type="image/png" sizes="16x16" href="/favicon-16.png" />
        <link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png" />
        <link rel="manifest" href="/manifest.webmanifest" />
      </Head>
      <body className="antialiased">
        <Main />
        <NextScript />
      </body>
    </Html>
  );
}
