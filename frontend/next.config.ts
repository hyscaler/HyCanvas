import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  output: "export",
  trailingSlash: true,
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
