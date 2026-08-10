// Custom 404 (Pages Router). Statically exported to out/404.html and served by
// the Go static handler for unknown paths. The visual lives in the shared
// NotFoundScreen so the editor's "design not found" state reads identically.

import Head from "next/head";
import { NotFoundScreen } from "@/components/ui/NotFound";
import { tr } from "@/lib/i18n";

export default function NotFound() {
  return (
    <>
      <Head>
        <title>{tr("page.page_not_found_hycanvas")}</title>
        <meta name="robots" content="noindex" />
      </Head>
      <NotFoundScreen />
    </>
  );
}
