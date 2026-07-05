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
  returns a `ProposalDraft` carrying a _requested_ qty only; the risk manager
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

## T1.2 — RiskManager (packages/core)

- **Pure, DB-free gate.** `RiskManager` reads a `RiskContext` snapshot (equity,
  open positions, kill-switch flag) and returns a `RiskDecision` — either an
  approved, fully-sized `TradeProposal` or a rejection carrying the exact
  `RiskEvent` (rule + reason + context + severity) for the caller to persist to
  `risk_events`. Core stays free of DB deps; T1.3/pipeline own persistence.
- **Config clamps to the globals, never exceeds.** The constructor computes
  `limits` as `min(param, GLOBAL_RISK_LIMITS)` per field, encoding "config can
  tighten but not exceed" (spec §5) in code rather than trusting the caller.
- **Rule order = cheap structural checks first, sizing last:** kill switch →
  stop validity (right side of entry) → no averaging down (same
  ticker+side+strategy already open) → max total / per-strategy / per-ticker
  position caps → per-trade sizing → total open risk. First failing rule wins,
  giving one precise reason string per rejection.
- **Sizing is whole-share, budget-bounded.** `qty = floor((equity ×
maxRiskPerTradePct%) / |entry − stop|)`; `qty < 1` ⇒ `per_trade_risk`
  rejection (stop too wide). `riskUsd`/`riskPct` are stamped by the manager, so
  by construction an approved proposal is always within the per-trade budget.
- **Rule codes are a stable contract.** `RISK_RULES` is a closed union persisted
  verbatim to `risk_events.rule`; reason strings are asserted exactly in the
  table-driven tests so a wording change can't silently drift.
- **Kill-switch trip lives here, action lives in T1.3.** `checkDailyLoss`
  compares day P&L% to `-dailyLossLimitPct` and, on breach, returns a `tripped`
  result with a _critical_ `daily_loss_limit` event. Trips exactly at −3%
  (`≤ -limit`); the actual block-orders / all-strategies-→-WATCH / notify is the
  kill-switch service (T1.2 provides the trigger).
- **Options guard is types-now.** `definedRiskOptionsOnly` is carried on
  `RiskParams` but not runtime-enforced (equities MVP; options math is Phase 3).
- **AC verified:** table-driven tests for every rule with exact persisted reason
  strings; kill-switch trip test at −3% day P&L; 66 core tests, 100%
  statements/functions/lines, 97.95% branches (threshold 90%).

## T1.3 — Kill switch service (apps/api)

- **New `kill_switch` singleton table** (migration `0001`) is the source of
  truth: `active`, `reason`, `tripped_by`, `tripped_at`, `rearmed_at`. Keyed by
  the constant `KILL_SWITCH_ID` ("global"); the repository ensures the row lazily
  (`insert … onConflictDoNothing`) so no seed step is required.
- **Redis mirrors the flag for the order path.** Postgres is authoritative;
  `killswitch:active` in Redis gives the executor a cheap cross-process check.
  `isActive()` reads cache-first, falls back to the DB, and — critically —
  **fails safe to ACTIVE (blocked)** if both are unreachable.
- **Collaborator injection over direct DB coupling.** The service depends on four
  small interfaces (repository, strategy registry, audit sink, cache) with
  Drizzle/Redis implementations in prod and in-memory fakes in the test. This is
  what makes the AC's integration test run in CI with no live Postgres/Redis.
- **Demotion is AUTO/APPROVE → WATCH only.** WATCH and OFF are left untouched —
  the kill switch stops trading; it must never _wake_ a disabled strategy. The
  pre-change mode is captured (select-then-update) so the audit `before` is real.
- **Re-arm needs the exact typed phrase** `REARM_CONFIRMATION` ("RE-ARM
  TRADING") and, by design, does **not** restore strategy modes — re-enabling a
  strategy is a separate, deliberate user action. `DELETE /killswitch` carries
  the confirmation in the body; a wrong phrase is a 400 and leaves state active.
- **Append-only audit on every transition:** one `kill_switch/global` row per
  trip and re-arm, plus one `strategy/<id>` demotion row each (spec ground
  rule 7). Broadcasts a `critical` alert on trip / `warning` on re-arm via the
  WS `alerts` channel (new `EventsGateway.emitAlert`).
- **Enforcement seam for T1.4+:** `assertOrdersAllowed()` throws
  `KillSwitchActiveError` (403); the simulator/executor calls it before placing
  any order. The RiskManager already accepts `killSwitchActive` in its context,
  so the switch gates both the risk gate and the order path.
- **AC verified:** integration test trips the switch and asserts a pending
  proposal cannot execute, AUTO/APPROVE strategies demote to WATCH (WATCH/OFF
  untouched), and audit rows exist for the trip + each demotion; plus wrong-phrase
  rejection, re-arm clears the block without restoring modes, and fail-safe.
  Migration `0001` applied cleanly to a live Postgres 17; 106 tests green.

## T1.4 — Simulator / SIM ExecutionPort (packages/core)

- **The sim engine is pure, in-memory core — like `RiskManager`.** It does no
  I/O: state (virtual portfolios, working brackets, fills) lives in `Map`s and is
  driven by market events. The T1.6 pipeline / apps/api owns persistence
  (`sim_portfolios`, `orders`, `fills`, `positions`) and the audit log. This is
  what keeps the money path testable in CI with no Postgres/Redis.
- **Deterministic by construction (replay, T3.1).** No `Date.now`/`Math.random`:
  ids come from a monotonic counter (`sim-b1`, `sim-o1`), and every fill/open/
  close timestamp is threaded in from the driving `onBar`/`updateQuote` event.
  The "1,000 random trades" and "one-leg-only" property tests use a seeded
  mulberry32 PRNG instead of adding a `fast-check` dependency — the package keeps
  its zero-runtime-dep discipline (only `zod`).
- **Pessimistic fill model (spec §4.4).** Fills never cross at mid: a buy lifts
  the ask, a sell hits the bid, each degraded further by adverse slippage
  (default 5 bps). When no live quote exists a bid/ask is synthesized around the
  bar close with a configurable spread (default 10 bps). IB fixed-tier commission:
  `$0.005/share`, `$1.00` min, capped at `1%` of trade value.
- **Market entries fill immediately if a quote already exists, else on the next
  event.** Limit entries wait until price trades through the limit (bar spans it,
  or the quote's marketable side reaches it). Avoids look-ahead while still giving
  natural immediate fills in live-sim.
- **One-cancels-other with a pessimistic tie-break.** Stop and target are
  monitored on each bar; if a single bar spans both levels the **stop is assumed
  hit first**, so a bracket can never realize both legs (proved by the property
  test: a closed bracket has exactly 2 fills — one entry, one exit). Gap-through
  is modeled: a long stop fills at `min(stop, bar.open)` (worse than the stop).
- **Accounting balances to the cent.** Cash mutations and realized P&L are
  computed from the _same_ `roundCents`-rounded fill values, so when the book is
  flat `cash − startingCash === Σ realizedPnl` exactly — asserted over 1,000
  seeded random round-trips.
- **No naked positions.** `modifyBracket` enforces downward-only qty (a reduction
  scales out the difference at market; an increase throws — no averaging up);
  cancelling a _filled_ bracket flattens the position at the current mark rather
  than leaving it unprotected.
- **`resetPortfolio` returns a `PortfolioResetRecord`** (cash/realized before,
  open positions discarded, cash after, `resetAt`) for the caller to write to
  `audit_log` and stamp `sim_portfolios.reset_at` — reset does no logging itself,
  matching the "core emits, caller persists" pattern.
- **AC verified:** 21 simulator tests (87 total in core), incl. both property
  tests; coverage on `simulator.ts` 95.5% stmts / 90.7% branch (≥90% money-path
  bar); typecheck + eslint clean.

## T1.5 — LLM analyst service

- **The service is the single trust boundary; collaborators are dumb.** The
  transport (`AnthropicAnalystClient`) only calls Claude and returns the raw
  candidate/text or throws; the repository only appends a row. All fail-safe
  policy lives in `LlmAnalystService`: it converts **every** failure mode —
  timeout, transport error, model refusal, malformed JSON, schema violation —
  into a deterministic **veto** via `@magpie/core`'s `vetoAnalysis` /
  `parseLlmAnalysis`. So the money path can never mistake a broken analysis for
  a pass (spec §4.2), and the policy is testable in one place without a network.
- **30s hard ceiling enforced in the service, not just the SDK.** An
  `AbortController` + `setTimeout` races the transport (`Promise.race`); on
  overrun it aborts the in-flight request and vetoes. Belt-and-suspenders: the
  SDK call _also_ gets `{ timeout: 30_000 }`, but the service-level guard is what
  the unit test exercises (a hanging client is aborted and vetoed).
- **Structured output via `output_config.format` (json_schema), not the Zod
  parse helper.** `zodOutputFormat` targets `zod/v4` while the repo is on zod v3;
  to avoid version coupling the client sends a hand-written JSON schema
  (`LLM_OUTPUT_JSON_SCHEMA`) and `JSON.parse`s the constrained text, then the
  core `LLMAnalysisSchema` re-validates it. Request-side constraint + core-side
  trust boundary are kept separate on purpose.
- **Model is configurable, default `claude-sonnet-5`.** Read from
  `ANTHROPIC_MODEL` (already in the env schema); a Sonnet-class default per the
  task spec. Web search enabled per-request via the `web_search_20260209` server
  tool when `AnalysisRequest.webSearch` is set.
- **The LLM still never sees numbers.** The prompt carries only the strategy's
  question, required checks, and non-sizing context; the system prompt states the
  model's entire authority is a binary proceed/veto and to veto when uncertain.
- **Persistence is best-effort and skipped without a `signalId`.**
  `llm_analyses.signal_id` is a NOT NULL FK, so un-persisted signals (no id) skip
  the write and just return the verdict. A persist failure is logged, never
  thrown — a DB hiccup can't flip a verdict or crash the pipeline.
- **Live smoke test is out of CI.** `pnpm --filter @magpie/api smoke:llm`
  (`src/llm/smoke.ts`) hits the real API and needs `ANTHROPIC_API_KEY`; unit
  tests mock the transport, so CI needs no key.
- **AC verified:** 6 analyst tests (proceed / veto / garbage / transport-throw /
  no-signalId / timeout), 41 api tests total; typecheck + eslint + prettier clean;
  full `pnpm -r build` green.
