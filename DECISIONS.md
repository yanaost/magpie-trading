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

### T0.5 IB market data adapter

- **Client:** `@stoqey/ib` 1.6.3. It ships CommonJS, so it is loaded from our
  ESM code via `createRequire(import.meta.url)` in `ib-client-factory.ts` (the
  standard ESM→CJS bridge) rather than a static import — construction is
  deferred until a live connection is actually requested. Verified at runtime
  that the factory constructs a real `IBApi` with `connect`/`reqHistoricalData`.
- **Testability seam:** the adapter is split so the money-relevant logic is pure
  and unit-tested without a gateway:
  - `bar-parser.ts` — pure IB-bar → `CandleRow` mapping (dates, `-1` padding
    and `finished-…` sentinel handling, numerics as strings). Proven by a
    **recorded-fixture test** (T0.5 AC allows this off market hours).
  - `pacing-queue.ts` — serialized, rate-limited request queue with exponential
    backoff on IB pacing errors (codes 162/420 or "pacing" in the message).
    Clock is injectable; tests are deterministic with a virtual clock.
  - `ib-connection.ts` — connect/reconnect lifecycle with exponential backoff,
    normalizing raw positional event args into structured events. The IBApi
    factory + timers are injectable, so the **disconnect/reconnect test** runs
    against a fake socket (T0.5 AC).
- **Event arg order** taken from the installed decoder (not memory):
  `historicalData(reqId,date,o,h,l,c,vol,barCount,WAP,hasGaps)` with a
  `finished-…` end sentinel; `realtimeBar(reqId,time,o,h,l,c,vol,wap,count)`
  where `time` is unix seconds. Historical requests use `formatDate=2`
  (epoch seconds) for deterministic parsing.
- **Timeframes:** daily stored as `1d`, 5-min as `5m`, realtime 5-second bars as
  `5s` in `candles.timeframe` (free-text column). Daily backfill duration uses
  `N D` (≤365) or `⌈N/365⌉ Y`; 5-min is bounded to ≤10 days per request to stay
  within IB intraday history limits.
- **Writes** use a single `INSERT … ON CONFLICT (ticker,timeframe,ts) DO UPDATE`
  (idempotent re-backfill). Verified end-to-end against real Postgres: insert 3
  rows, re-write stays at 3, a changed close upserts correctly.
- **Backfill CLI:** `apps/api` script `ingest:backfill` (`--tickers`, `--days`),
  runnable standalone (`new MarketDataService(...)`, no full Nest bootstrap).
- **Live subscription** is gated by `MARKET_DATA_ENABLED` (default `false`) so
  the API boots without a gateway; when enabled it subscribes realtime bars for
  `MARKET_DATA_TICKERS` on connect and persists them.
- **Live gateway verification deferred:** no IB paper gateway / Docker on this
  host, so `ingest:backfill` against a live gateway and market-hours realtime
  bars are deferred to an IB-connected host. The parsing, pacing, reconnect, and
  DB-write paths are all covered by tests / real-Postgres checks per the AC.

## T0.6 — Bare dashboard (apps/web)

- **Next.js 15 App Router, standalone tsconfig.** `apps/web` does not extend the
  repo's NodeNext base tsconfig — Next wants `moduleResolution: "bundler"` and
  `jsx: "preserve"`, and NodeNext's explicit-`.js`-extension rule fights JSX
  imports. Kept `strict: true` (+ `noUnusedLocals/Parameters`) to satisfy ground
  rule 1. ESLint stays centralized at the repo root (`next lint` disabled via
  `eslint.ignoreDuringBuilds`); added `**/next-env.d.ts` to root ESLint ignores
  since that generated file uses a triple-slash reference the config forbids.
- **Auth = HMAC-derived session cookie, checked in a server component (not edge
  middleware).** The single-user "password" is `APP_AUTH_SECRET`. Login
  constant-time-compares the submitted secret, then stores
  `HMAC-SHA256(secret, "trading-app-session-v1")` (base64url) in an HttpOnly,
  SameSite=Lax cookie (`secure` in prod). Every protected request re-derives the
  token and `timingSafeEqual`s it. Auth lives in `requireAuth()` called from the
  `/` server component so it can use `node:crypto` (unavailable on the edge
  runtime); no middleware. The cookie holds a derived token, never the secret.
- **Login via plain form POST + 303 redirect, no client JS.** `/login` is a
  server component with a `<form method="post" action="/api/login">`; the route
  handler sets the cookie and redirects. Wrong secret → `303 /login?error=1`
  with no cookie. Keeps the auth path dependency-free and progressively
  enhanceable.
- **Live status over WebSocket via a server-side `StatusBroadcaster`.** A NestJS
  provider (`ws/status.broadcaster.ts`) polls `HealthService.check()` every
  `HEALTH_BROADCAST_MS` (default 5s) and emits the report on the gateway's
  `health` channel; it emits once on init so a fresh client isn't blank. The
  `LiveStatus` client component subscribes with `socket.io-client` and renders
  gateway/dep badges. Chose server-push over client polling so the page reflects
  `/healthz` live per the AC.
- **Dashboard data via two read-only REST endpoints.** `GET /api/strategies`
  (Drizzle select over `strategies`) and `GET /api/candles/counts` (raw
  `group by ticker, timeframe` — small integer counts) back the tables. The `/`
  server component fetches both with `cache: "no-store"`; API errors degrade to
  an inline message rather than a 500. Added `app.enableCors({ origin: true,
  credentials: true })` so the browser WS/handshake from `:3000` reaches `:3001`.
- **AC verified end-to-end on a local stack** (Postgres.app + redis-server, no
  Docker on this host): unauth `GET /` → 307 `/login`; wrong secret rejected with
  no cookie; correct secret sets the cookie and `GET /` returns 200 with all 8
  seeded strategies server-rendered; a real `socket.io-client` received repeated
  `health` pushes 3s apart. `NEXT_PUBLIC_API_URL`/`API_URL` split the browser vs
  server API base.

## T1.1 — Domain core (packages/core)

- **Money is `number` in the domain, string only at the DB edge.** Prices, qty
  and cash are plain `number`s in every core type so the money path can do
  arithmetic and round deliberately (`roundCents`). The repository layer converts
  Drizzle's `numeric`→string columns at the boundary. Ambiguity resolved toward
  the simpler option (spec ground rule) — no decimal/bignum library for the MVP;
  positions are equities and whole-cent granularity is sufficient.
- **Zod on payloads, bare interfaces for behavior.** Everything that crosses a
  process/db boundary (`QuantSignal`, `AnalysisRequest`, `LLMAnalysis`,
  `ProposalDraft`, `TradeProposal`, `Position`, `ExitAction`, bracket/order/fill
  payloads, all enums) carries a zod schema + inferred type. The in-process
  behavioral contracts (`MarketContext`, `ExecutionPort`, `Strategy`) are plain
  TS interfaces with no schema — they are method surfaces, not serialized data.
- **`ProposalDraft` vs `TradeProposal` split.** A strategy's `buildProposal`
  returns a `ProposalDraft` carrying a *requested* qty only; the risk manager
  (T1.2) owns sizing and produces the finalized `TradeProposal` with
  `riskUsd`/`riskPct`/`status`. This encodes the rule "the LLM/strategy never
  sets final size" in the type system, not just convention.
- **`parseLlmAnalysis` fails safe to a veto.** The untrusted LLM response is
  parsed with `safeParse`; any malformed, out-of-range, or non-object input (and
  the timeout/transport path via `vetoAnalysis`) returns a zero-confidence
  `veto`, never a `proceed`. This is the money-critical guard from spec §4.2 and
  carries the heaviest test coverage.
- **Exit-before-entry baked into the schemas.** `ProposalDraft`/`TradeProposal`
  require a `stop` and an `exitPlan`, and `BracketOrderRequest` requires a
  `stopPrice`; there is no way to construct a valid entry without a protective
  stop. Every entry is a bracket (parent + stop + optional take-profit).
- **`GLOBAL_RISK_LIMITS` frozen; `RiskParams` may only tighten.** The global
  ceilings (spec §5) are a frozen constant; per-strategy `RiskParams` are
  overrides the risk manager will enforce as tightenings, never loosenings.
  `DEFAULT_RISK_PARAMS` is the loosest config still inside the ceilings.
- **`LivePromotionLockedError` lives in core.** Both the SIM and the future IB
  execution ports throw the same named error for any `LIVE` order, so the
  no-live-trading lock (ground rule 3) is one shared type, not duplicated.
- **`ExecutionTarget` superset kept as `SIM`/`PAPER`/`LIVE`** and
  `StrategyTimeframe` as `intraday|swing|weekly|observation|filter` to mirror the
  `@magpie/db` pgEnums exactly — enums are the single source of truth and must
  not drift from the schema.
- **AC verified:** `tsc` compiles clean across all 4 workspace projects; JSDoc on
  every exported symbol; zod schemas on all boundary payloads; 48 core tests pass
  at 100% statement/branch/function/line coverage (threshold enforced at 90% via
  `packages/core/vitest.config.ts`, `strategy.ts` excluded as type-only).
