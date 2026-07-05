import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  output: "export",
  trailingSlash: true,
  // yjs must load as ONE module instance (two copies break instanceof checks
  // inside the CRDT bridge: yjs issue #438). @hc/realtime is built as ESM so
  // every consumer resolves the same yjs.mjs; no resolve alias needed (a
  // previous yjs -> yjs/src alias hung Turbopack's dev compile of any chunk
  // importing yjs, wedging the dashboard on its loading screen).
  // Transpile the workspace packages so Next bundles them cleanly.
  transpilePackages: [
    "@hc/schema",
    "@hc/engine",
    "@hc/editor",
    "@hc/sdk",
    "@hc/authz",
    "@hc/export",
    "@hc/commandmenu",
  ],
  images: {
    unoptimized: true,
  },
  env: {
    NEXT_PUBLIC_BACKEND_URL:
      process.env.BUILD_DIST === "true"
        ? "/api"
        : process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:8005/api",
  },
};

export default nextConfig;
