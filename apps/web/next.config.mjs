import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { config as loadDotenv } from "dotenv";

// Load the repo-root .env before Next reads process.env. `next dev` only
// auto-loads .env files from apps/web, but this monorepo keeps a single root
// .env — resolve it from this config's location (not the cwd) so server code,
// route handlers, and NEXT_PUBLIC_* inlining all see the shared secrets.
loadDotenv({
  path: resolve(dirname(fileURLToPath(import.meta.url)), "../../.env"),
});

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Linting is handled by the repo-root flat ESLint config (`pnpm lint`).
  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;
