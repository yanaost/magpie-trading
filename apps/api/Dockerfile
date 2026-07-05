# Multi-stage build for the NestJS API. Build context is the repo root
# (see docker-compose.yml: context: ., dockerfile: apps/api/Dockerfile).
FROM node:22-alpine AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /app

FROM base AS build
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @trading-app/core --filter @trading-app/db --filter @trading-app/api build

FROM base AS runtime
ENV NODE_ENV=production
# Copy the built workspace (incl. workspace symlinks in node_modules).
COPY --from=build /app /app
EXPOSE 3001
# wget (busybox) backs the compose healthcheck.
CMD ["node", "apps/api/dist/main.js"]
