import { Html, Head, Main, NextScript } from "next/document";
import { brand } from "@/lib/theme.generated";
import { themeBootScript } from "@/lib/theme";
import { localeBootScript } from "@/lib/locale";
import { tr } from "@/lib/i18n";

export default function Document() {
  // The app is statically exported, so this markup is identical for every user
  // and cannot carry their locale. The boot script below replaces both
  // attributes before first paint. They are still declared here because a page
  // with NO language at all fails WCAG 3.1.1 for anyone reaching it without
  // scripts, and for crawlers.
  return (
    <Html lang="en" dir="ltr">
      <Head>
        {/* Apply the stored dark-mode preference before first paint (no flash). */}
        <script dangerouslySetInnerHTML={{ __html: themeBootScript }} />
        {/* Set lang and dir before first paint: a mirrored layout arriving a
            frame late moves every element on the page. */}
        <script dangerouslySetInnerHTML={{ __html: localeBootScript }} />
        <meta name="theme-color" content={brand["600"]} />
        {/* Social share card (Open Graph + Twitter): the banner shown when a
            HyCanvas link is unfurled in chat, social, and previews. The image is
            an absolute URL on the brand host so it resolves from any origin. */}
        <meta property="og:type" content="website" />
        <meta property="og:site_name" content={tr("page.hycanvas_2")} />
        <meta property="og:title" content={tr("page.hycanvas_2")} />
        <meta property="og:description" content={tr("page.a_free_ai_native_visual_design_platform")} />
        <meta property="og:image" content="https://brand.hycanvas.com/assets/png/og-image-1200x630.png" />
        <meta property="og:image:type" content="image/png" />
        <meta property="og:image:width" content="1200" />
        <meta property="og:image:height" content="630" />
        <meta name="twitter:card" content="summary_large_image" />
        <meta name="twitter:title" content={tr("page.hycanvas_2")} />
        <meta name="twitter:description" content={tr("page.a_free_ai_native_visual_design_platform")} />
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
