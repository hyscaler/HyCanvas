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
        {/* Social share card (Open Graph + Twitter): the banner shown when a
            HyCanvas link is unfurled in chat, social, and previews. The image is
            an absolute URL on the brand host so it resolves from any origin. */}
        <meta property="og:type" content="website" />
        <meta property="og:site_name" content="HyCanvas" />
        <meta property="og:title" content="HyCanvas" />
        <meta property="og:description" content="A free, AI-native visual design platform." />
        <meta property="og:image" content="https://brand.hycanvas.com/assets/png/og-image-1200x630.png" />
        <meta property="og:image:type" content="image/png" />
        <meta property="og:image:width" content="1200" />
        <meta property="og:image:height" content="630" />
        <meta name="twitter:card" content="summary_large_image" />
        <meta name="twitter:title" content="HyCanvas" />
        <meta name="twitter:description" content="A free, AI-native visual design platform." />
        <meta name="twitter:image" content="https://brand.hycanvas.com/assets/png/og-image-1200x630.png" />
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
