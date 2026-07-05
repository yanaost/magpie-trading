/** @type {import('next').NextConfig} */
const nextConfig = {
  // Linting is handled by the repo-root flat ESLint config (`pnpm lint`).
  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;
