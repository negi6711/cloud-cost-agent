import type { NextConfig } from "next";

// Environment: the npm scripts load the repo-root .env (node --env-file-if-exists), so the web app,
// worker and db scripts share one file locally. Hosted deploys use platform env vars.
const nextConfig: NextConfig = {
  // Workspace packages ship TypeScript source.
  transpilePackages: ["@cca/config", "@cca/domain", "@cca/db"],
  poweredByHeader: false,
};

export default nextConfig;
