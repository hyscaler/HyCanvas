// Custom 404 (Pages Router). Statically exported to out/404.html and served by
// the Go static handler for unknown paths. The visual lives in the shared
// NotFoundScreen so the editor's "design not found" state reads identically.

import Head from "next/head";
import { NotFoundScreen } from "@/components/ui/NotFound";

export default function NotFound() {
  return (
    <>
      <Head>
        <title>Page not found · HyCanvas</title>
        <meta name="robots" content="noindex" />
      </Head>
      <NotFoundScreen />
    </>
  );
}
