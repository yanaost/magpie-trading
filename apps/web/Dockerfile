# Multi-stage build for the Next.js dashboard. Build context is the repo root
# (see docker-compose.yml: context: ., dockerfile: apps/web/Dockerfile).
FROM node:22-alpine AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /app

FROM base AS build
COPY . .
RUN pnpm install --frozen-lockfile
# NEXT_PUBLIC_* is inlined at build time — bake the browser API base in here.
ENV NEXT_PUBLIC_API_URL=http://localhost:3001
RUN pnpm --filter @magpie/web build

FROM base AS runtime
ENV NODE_ENV=production
# Copy the built workspace (incl. the compiled .next output + node_modules).
COPY --from=build /app /app
WORKDIR /app/apps/web
EXPOSE 3000
# wget (busybox) backs the compose healthcheck.
CMD ["pnpm", "start"]
