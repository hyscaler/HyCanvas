import { Html, Head, Main, NextScript } from "next/document";
import { brand } from "@/lib/theme.generated";

export default function Document() {
  return (
    <Html lang="en">
      <Head>
        <meta name="theme-color" content={brand["600"]} />
      </Head>
      <body className="antialiased">
        <Main />
        <NextScript />
      </body>
    </Html>
  );
}
