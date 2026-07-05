# DECISIONS.md

Running log of judgment calls made while building the app (per TASKS.md ground
rule 10). Newest at the bottom of each phase.

## Phase 0

- **Node runtime:** TASKS.md targets Node 22. The local dev machine runs Node
  20.12. CI pins Node 22. The codebase is Node-22-compatible; `engines.node` is
  set to `>=20.12.0` so local builds work while CI validates the target. No
  Node-22-only syntax is used.
- **Package manager:** pnpm 9.15.9 (activated via Corepack).
- **Build tooling:** each package builds with plain `tsc` (no bundler) to keep
  the toolchain minimal and debuggable; libraries emit `dist/` with
  declarations. Apps (NestJS/Next.js) use their own framework builds.
- **ESLint:** flat config (`eslint.config.js`) with `typescript-eslint`, since
  ESLint 9 is current. `no-explicit-any` is an error in domain code (ground
  rule 1), relaxed only in test files.
- **Module system:** ESM everywhere (`"type": "module"`), TS `NodeNext`
  resolution. Relative imports use explicit `.js` extensions.
- **LLM default model:** `claude-sonnet-5` (a current Sonnet-class model) per
  spec §4.1 / TASKS T1.5. Configurable via `ANTHROPIC_MODEL`.

### T0.2 docker-compose

- **Images pinned:** `timescale/timescaledb:2.17.2-pg16`, `redis:7-alpine`,
  `ghcr.io/gnzsnz/ib-gateway:stable`. Pinning the Timescale tag avoids surprise
  major bumps in the money path.
- **IB gateway paper port is 4004 on the compose network, not 4002.** The
  gnzsnz image runs the API on `127.0.0.1:4001/4002` internally and socat-
  republishes to `0.0.0.0:4003/4004` (live/paper). Other containers therefore
  connect to `ib-gateway:4004` for paper; the `api` service overrides
  `IB_GATEWAY_PORT=4004`. `.env.example` keeps `4002` as the native/default for
  a gateway run outside compose. Documented in `infra/README.md`.
- **Gateway not host-published:** uses `expose` only (no `ports:`), so it is
  reachable solely from `trading-net` members — satisfies the T0.2 AC and
  spec §10. Postgres/redis are published to `127.0.0.1` only, for local dev
  tooling (migrations, psql).
- **api/web behind the `apps` compose profile:** their Dockerfiles arrive with
  T0.4 / T0.6. `docker compose up` brings the data+broker layer healthy today;
  `docker compose --profile apps up` runs the full stack once the apps exist.
- **Gateway healthcheck** is a TCP probe on the socat paper port (4004) with a
  150s `start_period` (IBC login is slow). It proves the socat listener is up,
  not full session auth — the app's `/healthz` (T0.4) confirms the live link.
- **Verification deferred:** Docker is not installed on the current dev machine,
  so `docker compose up` healthy-state verification is deferred to a Docker-
  capable host. Compose structure validated statically (5 services; gateway
  internal-only; api→4004).

### T0.3 database schema + migrations

- **New package `packages/db`** (beyond the structure sketch in TASKS) holds the
  Drizzle schema, client, and migrate/seed scripts. Rationale: both the API and
  standalone CLI scripts (migrations, the T0.5 ingestion backfill) need DB
  access outside the NestJS process, so the data layer is its own package rather
  than living inside `apps/api`.
- **Driver:** `postgres` (postgres.js) + `drizzle-orm`; `drizzle-kit` for
  migration generation. Numeric columns come back as strings (precision-safe);
  the app converts deliberately, never the LLM.
- **`timeframe` enum is a superset** of spec §3.1's `intraday|swing|weekly` —
  adds `observation` (strategy #8) and `filter` (strategy #6) so the whole
  roster fits one column. Core types (T1.1) will match this superset.
- **Hypertable conversion runs in `migrate.ts` as a guarded post-step**, not a
  versioned SQL migration: it creates the extension + `create_hypertable` only
  when `timescaledb` is available, else logs a NOTICE and leaves `candles` a
  plain table. This makes `db:migrate` succeed on plain Postgres (local dev)
  and produce a real hypertable on the Timescale image. Idempotent.
- **Seed is idempotent** via `onConflictDoNothing` on `strategies.id` — never
  clobbers a mode/target the user has changed. Roster extracted to
  `seed-data.ts` so it is unit-testable without a DB.
- **Verified against a real Postgres 17.6** (throwaway local cluster): migrate
  from zero → 13 tables; seed → 8 strategies all `WATCH`/`SIM`; candles PK =
  `(ticker, timeframe, ts)`; re-seed inserts 0. Hypertable creation itself is
  verified on the Timescale Docker image (deferred, extension absent locally).

### T0.4 NestJS skeleton

- **NestJS runs as ESM** (`"type": "module"`, NodeNext) to match the rest of the
  monorepo and consume the ESM `@trading-app/db`/`core` packages natively —
  avoids the CJS→ESM interop pain. Requires `experimentalDecorators`,
  `emitDecoratorMetadata`, and `useDefineForClassFields: false` in the api
  tsconfig for Nest DI to work; relative imports carry explicit `.js`.
- **Config** is a hand-rolled global module validating `process.env` with zod
  (`loadConfig`), exposed via the `APP_CONFIG` token (frozen object). Chose this
  over `@nestjs/config` for a single, typed, fail-fast validation point.
- **Logging** via `nestjs-pino`; Nest's logger is routed through pino
  (`app.useLogger`). Pretty transport in dev, JSON in prod.
- **Health** (`/healthz`) probes db (`select 1`), redis (`ping`), and gateway
  (TCP connect) independently with a 1.5s timeout each; never throws — a down
  dep yields `"down"` and overall `status: "degraded"`. `sql` is re-exported
  from `@trading-app/db` so the app doesn't depend on drizzle directly.
- **BullMQ** via `@nestjs/bullmq`; connection parsed from `REDIS_URL` (isolated
  from the shared health/cache ioredis client). Demo heartbeat uses
  `upsertJobScheduler` (idempotent) and is resilient to Redis being down at boot.
  Interval is `DEMO_JOB_INTERVAL_MS` (default 30_000).
- **WS gateway** is a socket.io stub (`EventsGateway`) ready to emit the spec §8
  channels; only `gateway-status` broadcast is wired for Phase 0.
- **Verified live**: booted the built app against local Postgres 17.6 + Redis;
  `/healthz` returned `db:up, redis:up, gateway:down` (nothing on 4002), and the
  heartbeat logged every tick. AC met.
