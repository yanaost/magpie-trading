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

## T1.6 — Signal pipeline orchestrator

- **The orchestrator is I/O-free; everything is a port.** `PipelineService`
  wires `scan` → LLM analyst → crowding hook → RiskManager → mode gate → position
  monitor purely through the interfaces in `pipeline.types.ts`. This is what makes
  the whole mode-gate flow integration-testable with in-memory fakes (the T1.6
  AC) and swappable for Drizzle/BullMQ in production.
- **"Core emits, caller persists" holds.** The service sequences the pure
  collaborators (RiskManager sizes/gates, the analyst fails safe to veto, the
  execution port brackets every entry) and records the audit/journal trail; it
  never re-derives money-path numbers.
- **Mode gate (spec §3.2):** AUTO persists → places a market bracket → records the
  bracket → marks the proposal executed → audits `auto_execute`; APPROVE persists
  a pending proposal → notifies (WS `proposals`) → journals; WATCH journals only;
  OFF short-circuits before scanning. Veto, crowding, and risk-rejection each stop
  the signal before the gate (risk-rejection also persists a `risk_events` row).
- **Position→bracket correlation via `BracketIndex`.** SIM brackets live in the
  Simulator's memory and the emitted `Position` carries no bracket id, so the
  pipeline records `strategyId:ticker → bracketId` at placement and resolves it in
  the monitor. Keyed on `strategyId:ticker` because "no averaging down" guarantees
  at most one open bracket per key. In-memory now; a Drizzle resolver can replace
  it behind the same port once orders/fills are reconciled.
- **`Strategy.manage` → bracket ops.** close(no qty)/scale-out-to-zero → cancel +
  clear index; close(qty)/scale-out → modify newQty = remaining; modify-stop /
  modify-target → modify the corresponding leg. Every action is journaled.
- **TTL expiry sweep.** A repeatable `expiry` job marks pending proposals past
  `expiry` as `expired` (guarded on `status='pending'` so a concurrent
  approval/execution wins) and writes an `audit_log` before/after record.
- **Analyst injected as its own singleton port**, not per-runtime. It's stateless
  and shared, so `LLM_ANALYST` binds to an adapter over `LlmAnalystService` rather
  than being threaded through the strategy registry.
- **BullMQ wiring shares one Redis root.** The Bull root moved to an exported
  `BullRootModule` in `queue.module.ts`; `PipelineModule` imports `QueueModule`
  and `registerQueue`s the `pipeline` queue against it (scan / monitor / expiry
  jobs). Scheduler is idempotent (`upsertJobScheduler`) and resilient to Redis
  being down at boot, matching the demo heartbeat.
- **Environment providers target SIM only (the MVP rung).** `ExecutionPortProvider`
  serves a single in-process `Simulator`; `MarketContextProvider` reads candles
  from the `candles` table, synthesizes a quote from the latest close (the sim
  tolerates a null quote), and takes open positions from the sim. Account equity
  is a fixed MVP constant (100k) for risk sizing — a live-marked equity model
  lands with execution/reconciliation (T1.8). PAPER/LIVE rungs throw until the
  broker adapter exists.
- **Strategy registry joins DB row ⋈ code instance.** `DrizzleStrategyRegistry`
  reads the live mode/target/riskOverrides from `strategies` and pairs it with a
  registered `Strategy` instance; rows without code are skipped. `STRATEGY_INSTANCES`
  is empty until strategy #3 (QUAL/SPHB) registers in T1.7, so the scheduler
  no-ops safely until then.
- **AC verified:** 10 pipeline integration tests (AUTO / APPROVE / WATCH / OFF /
  veto / crowding / risk-reject / monitor modify-stop / monitor close-cancels /
  TTL expiry→expired+audit), 51 api tests total; typecheck + eslint + prettier
  clean; full `pnpm -r build` green.

## T1.7 — Strategy #3: QUAL/SPHB quality-rotation pair

- **New package `@magpie/strategies`** (pure domain, mirrors `@magpie/core`:
  ESM, `zod`, vitest, no I/O/clock). Holds concrete `Strategy` implementations
  that plug into the T1.6 pipeline. `allStrategies()` is the registration list
  the API joins against the `strategies` config rows by `id`.
- **Thesis:** `SPHB/QUAL` (high-beta ÷ quality) mean-reverts. A **fresh** cross
  of the ratio above `SMA·(1+entryBand)` (20-week SMA, 5% band) triggers a long
  **QUAL** rotation; the written exit closes when the ratio reverts to/below its
  SMA. Fresh-cross gating (prev bar below the band) means one signal per stretch,
  not one per extended bar.
- **Sync-manage contract (the key design call):** `Strategy.manage` is
  synchronous but the reversion test needs candle data, which `MarketContext`
  only exposes asynchronously. Rather than widen the shared core interface, the
  strategy **caches the latest `RatioView` during `scan`** (which the engine runs
  each cycle before the monitor) and `manage` reads that cache. Single pair, at
  most one open position, so no keying is needed. Documented in the class header.
- **Indicators are pure functions** (`ratioSeries`, `sma`, `ratioView`) with
  explicit `null` warm-up so a caller can't mistake an incomplete window for a
  real average — unit-tested directly, no fixtures.
- **Stop** is a fixed 8% below entry backing the thesis exit; there is no price
  target (the exit is ratio-driven). The risk manager sizes to the stop distance
  from the nominal `requestedQty`.
- **Seed row already existed** (`qual-sphb`, weekly, seeded WATCH/SIM); T1.7 only
  supplies the code instance via `STRATEGY_INSTANCES: allStrategies()`.
- **AC verified:** synthetic-fixture suite (warm-up gating, single fresh-cross
  signal, long-QUAL proposal w/ 8% stop, proceed/veto prompt, hold-then-revert
  exit) + a **2-year (104-week) weekly replay** asserting ≥2 clean round trips,
  never >1 concurrent position, every exit strictly after entry, every entry a
  genuine band stretch. 15 strategies tests; `src/qual-sphb` 100% stmts/lines,
  90%+ branch. Full workspace: 158 tests, typecheck + eslint + prettier + build
  all green.

## T1.8 — Approval flow (Telegram + REST)

- **Human-in-the-loop for APPROVE-mode proposals.** APPROVE-mode strategies
  persist a pending proposal and notify; T1.8 adds the decision side — a human
  can **approve** (place the bracket) or **reject** it, from either Telegram
  inline buttons or the REST API. AUTO mode is unchanged.
- **One shared execution path.** Extracted `placeBracketAndRecord` in
  `PipelineService`, used by both `executeAuto` (AUTO) and the new
  `decideProposal` (approval). Bracket placement → bracket-index record →
  `markExecuted` → audit → journal are therefore identical whether a machine or
  a human pulled the trigger; only `decidedBy` (`"auto"` vs `"user"`) and the
  audit action differ.
- **`decideProposal(id, "approve"|"reject", {qty?})` returns a typed outcome**
  (`executed` | `rejected` | `not-found` | `not-pending`) rather than throwing
  for control flow. The controller maps these to HTTP 404/409; only a genuine
  bad request (`ProposalDecisionError`) throws → 400.
- **Size can only be reduced on approval.** An operator may approve with a
  smaller `qty` (de-risk), never a larger one — `qty > proposal.qty` throws
  `ProposalDecisionError`. Simplest safe rule; upsizing would re-open the risk
  gate the RiskManager already cleared.
- **Guarded status transitions.** `markExecuted` / `reject` / `expire` are all
  `WHERE status = 'pending'` in SQL, so a double-tap (Telegram button pressed
  twice, or button + REST) can't double-execute — the second decision returns
  `not-pending`. Verified in tests.
- **Telegram split to avoid a module cycle.** The outbound `TelegramNotifier`
  (implements `ProposalNotifier`, no pipeline dependency) lives in a leaf
  `TelegramModule` that `PipelineModule` imports. The inbound `TelegramPoller`
  (needs `PipelineService`) lives in `ApprovalsModule`, which imports both.
  No cycle.
- **Composite notifier.** `PROPOSAL_NOTIFIER` is a `useFactory` that fans a
  pending proposal to both the WS and Telegram notifiers via
  `Promise.allSettled` — a dead Telegram never blocks the WS feed or the
  pipeline.
- **Fail-open Telegram.** `TelegramApi` returns `null` (never throws) on any
  transport/HTTP error and no-ops entirely when `TELEGRAM_BOT_TOKEN` is unset,
  so dev / CI / default-SIM boot without a bot and the trading path never fails
  because Telegram is down.
- **Tests.** `decideProposal` integration tests (approve executes the SIM
  bracket, downward-qty reduces size, upward-qty rejects, reject places no
  order, not-found, not-pending double-tap) reuse the T1.6 in-memory harness;
  Telegram notifier/poller unit tests fake the Bot API (no network); controller
  tests assert the outcome→HTTP-status mapping. Full workspace: 178 tests,
  typecheck + eslint + prettier + build all green.

## T1.9 — Dashboard v1 (apps/web + apps/api)

- **Dev trigger bypasses the strategy, not the money path.** The full-loop demo
  needs a signal on demand, but strategy #3's `buildProposal` is stateful and
  won't fire deterministically. `POST /dev/trigger/:strategyId`
  (`PipelineService.injectSyntheticProposal`) fabricates a `ProposalDraft`
  directly, then runs it through the **real** `RiskManager.evaluate` and the
  **real** `gateByMode` — so risk sizing, the kill-switch gate, the
  no-averaging-down rule, and the AUTO/APPROVE/WATCH/OFF fork are all exercised
  exactly as in production. Only the quant scan and the LLM analyst are skipped.
  Verified live: APPROVE→approve fills a SIM bracket and opens a position;
  tripping the kill switch turns the same trigger into
  `risk-rejected: kill_switch_active`; a second QUAL trigger while long is
  rejected `no_averaging_down`.
- **Dev trigger is gated, on by default off-prod.** `DEV_TRIGGER_ENABLED`
  (tri-state env) overrides; unset it defaults to `NODE_ENV !== "production"`.
  The controller throws `ForbiddenException` when disabled, so it can ship in
  the same image without exposing a synthetic-order endpoint in prod.
- **Controller seeds the SIM quote at the proposal entry.** Before injecting,
  the dev controller calls `simulator.updateQuote({bid,ask,last: entry})` so an
  approved market bracket fills at a known price — the demo is reproducible
  regardless of DB candle history (SIM positions are in-memory and never
  persisted).
- **Live UI = 3s poll + WS nudge, no new server plumbing.** Positions and
  approvals panels poll their REST endpoints every 3s and also subscribe to the
  existing socket.io gateway; the API `emit`s bare `positions` / `proposals`
  channel pings (after a fill / new proposal) that just trigger an immediate
  refetch. Avoids pushing full state over WS or standing up a new subscription
  protocol for v1.
- **Distance-to-stop, not P&L, this milestone.** The Simulator doesn't mark open
  positions (`unrealizedPnl` is always 0), so the positions table shows
  entry-relative distance-to-stop and open risk ($qty × |entry−stop|) instead of
  live P&L. The spec's P&L sparkline is **deferred to T2**, which brings marked
  positions. Noted so the missing sparkline reads as scoped, not dropped.
- **Config changes are audited.** `PATCH /api/strategies/:id` writes the mode /
  target change and an `audit_log` row (`before`/`after`, actor) in the same
  call; the registry re-reads mode/target every scan tick, so a change takes
  effect without a redeploy.
- **Re-arm doesn't restore modes.** A kill-switch trip demotes every strategy to
  WATCH; re-arming (typed-phrase confirm) clears the halt but leaves everything
  in WATCH — promoting back to AUTO/APPROVE is a deliberate manual step, called
  out in the kill-switch panel copy.
- **Tests.** `injectSyntheticProposal` pipeline tests (AUTO executes, APPROVE
  pends + notifies, WATCH/OFF watched, kill-switch rejects, unknown strategy
  throws) reuse the T1.6 in-memory harness; `DashboardService` tests cover
  distance-to-stop (long/short/missing-stop), portfolio rollup, and the audited
  `setStrategy`; `DevController` tests cover the enable/disable gate and the
  seed→inject→broadcast path. Full workspace: 195 tests, typecheck + eslint +
  prettier + build (incl. Next.js) all green. Full loop also verified live
  end-to-end over REST against Postgres + Redis.

## T2.1 — IB execution adapter (PAPER ExecutionPort)

- **Testable seam over @stoqey/ib, mirroring market-data.** `IbApiOrderGateway`
  wraps `IBApi` behind a narrow `IbOrderGateway` interface + injectable
  `IbOrderApiFactory`, so the whole order path is unit-tested against a fake
  EventEmitter with no live gateway. The real `IBApi` is built lazily by
  `createIbOrderApi` (CJS bridge via `createRequire`) and opens no socket until
  `connect()`.
- **Bracket = OCA group, exits live broker-side.** `placeBracket` stages
  parent(MKT/LMT, transmit:false) + stop(STP) + optional target(LMT), with only
  the _last_ leg transmitting so the broker receives the bracket atomically and
  the protective legs survive a gateway daily-restart. Stop/target use GTC; a
  protective fill closes the bracket (broker OCA cancels the sibling).
- **Fills are async, unlike SIM.** The port keeps an in-memory bracket model
  keyed by our stable `bracketId`, driven by gateway `orderStatus`/`fill`
  events. Parent-fill ⇒ position `open` (entry price from `avgFillPrice`;
  `openedAt` stamped on fill so `PositionSchema` is always well-formed even if
  the exact-time `execDetails` event lags). `getPositions(strategyId)` returns
  attributed open positions; `getFills(since)` returns buffered fills.
- **execDetails + commissionReport joined into one `fill`.** The gateway buffers
  the two halves keyed by `execId` and emits a single `fill` once orderId +
  shares + commission are all present — so the pipeline persists commission-true
  fills, never a bare execution.
- **Monotonic order-id allocator seeded by first `nextValidId`.** Later
  `nextValidId` values are ignored so the allocator is never rewound under the
  broker. `allocateOrderId()` throws before ready.
- **LIVE stays locked (rule 6).** `MultiTargetExecutionPortProvider` routes SIM
  → the shared in-process Simulator, PAPER → a lazily-built+connected
  `IbExecutionPort` (no socket on a SIM-only boot), LIVE → a hard
  `LivePromotionLockedError`. Distinct client id (`IB_CLIENT_ID + 1`) from the
  market-data connection to avoid a clash.
- **Reconciliation is pure.** `reconcile(brokerOrders, brokerPositions, known)`
  diffs broker truth against our books and returns typed mismatches
  (rogue_order / missing_order / rogue_position / position_drift) for the caller
  to alert on — satisfies the AC "reconciliation detects a manually placed rogue
  order" without a live gateway.
- **Paper integration is a manual smoke, not CI.** `apps/api/scripts/ib-smoke.ts`
  places+reads+cancels a tiny 1-share bracket against a running paper gateway;
  it needs the user's IBKR paper gateway (flagged for live verification) and is
  deliberately excluded from the automated suite. 32 execution unit tests green
  (gateway 8, port 10, recon 6, provider 3, + mapIbStatus); full workspace 115
  api tests + typecheck/eslint/prettier/build all green.

## T2.2 — Promotion gates

- **Ladder is SIM(0) < PAPER(1) < LIVE(2); only upward moves are gated.** A
  same-rung change (mode-only) and any demotion pass freely — you can always
  pull risk down. The gate math is a pure function (`evaluatePromotionGate`) so
  it's unit-tested in isolation (AC "gate math").
- **A promotion must be earned: ≥30 closed trades at the current rung + a review
  note.** Threshold `PROMOTION_MIN_CLOSED_TRADES = 30` (overridable per call).
  Checks run in order: LIVE-lock → note-present → trade-count, each with a stable
  rejection code (`LIVE_LOCKED` / `NOTE_REQUIRED` / `INSUFFICIENT_TRADES`).
  Closed trades counted per-rung from `positions` (status='closed', matching
  `target`), so PAPER trades don't count toward a future PAPER→… promotion's
  SIM history and vice-versa.
- **Promotion to LIVE is refused outright (rule 6),** not merely at order time.
  The T2.1 port already throws `LivePromotionLockedError`; the gate keeps the
  _config_ consistent by never letting `target` reach LIVE via promotion. (A
  demotion _from_ LIVE stays allowed in the math, though nothing can be at LIVE.)
- **Rejections are audited, then surfaced as 422.** A blocked promotion writes an
  `promotion_rejected` audit row (code + reason + observed trade count) before
  throwing `PromotionGateError`; the controller maps that to
  `UnprocessableEntityException` (422, body `{code, message}`) — distinct from
  the 400s for malformed input and the 404 for an unknown strategy. Successful
  changes keep the existing `config_change` audit, now including the note.
- **UI prompts for the note on promotion only.** `strategy-controls.tsx` detects
  an upward rung change and `window.prompt`s for a required review note before
  PATCHing; cancelling or leaving it blank aborts client-side. Demotions send
  immediately. Simplest path over a bespoke modal (noted per the
  simplest-path-first preference).
- Full gate green: 132 api tests (promotion 10, dashboard service 9, dashboard
  controller 4, + existing) + typecheck/eslint/prettier + Next.js build.

## T2.3 — Strategy plugin loader + tabs UI

- **The registry is the single registration seam.** `packages/strategies/registry.ts`
  holds a `STRATEGY_FACTORIES` array of zero-arg factories; `loadStrategies()`
  fans out over it (and de-dupes ids). Adding a strategy = new `src/<id>/` folder
  - one line in that array. `allStrategies()` now delegates here. A registry test
    proves a newly-registered dummy strategy flows through with no loader changes
    (AC: "dummy strategy appears with zero code changes elsewhere").
- **Tabs are fully data-driven off the API roster** (`GET /api/strategies`), so the
  UI never names a strategy. `strategy-tabs.tsx` renders one tab per returned
  strategy; the selected tab shows the full §3.3 layout — mode/target controls,
  the performance module, that strategy's open positions, and its signal log.
  A new strategy grows a tab with zero edits to any UI file.
- **Performance math lives in core, pure and unit-tested** (`performance.ts`):
  win rate, avg R, max drawdown, and the realized-PnL equity curve reduced from
  closed trades. R-multiple = realizedPnl / (qty × |entry − stop|); stop-less
  trades are excluded from avg R but still count in win rate and the curve. Max
  drawdown is peak-to-trough on the cumulative curve. Rounding is cent-granular
  and inlined (kept the module dependency-free — no import cycle with index.ts).
- **Performance is split by execution target** (`DashboardService.performance`
  → `GET /api/strategies/:id/performance`): closed positions grouped by
  SIM/PAPER/LIVE so a strategy's paper record never mixes with its sim record.
  Targets with no closed trades report the empty stats (stable UI panels) rather
  than being omitted.
- **Equity curve renders as a dependency-free inline SVG sparkline** — no chart
  library, CSP-safe, green/red by final sign. Simplest path over pulling in a
  charting dep for a 200×40 line.
- Full gate green: core 94 tests (perf +9), strategies 18 (registry +3), api 133
  (perf +1); typecheck/eslint/prettier + Next.js build.

## T2.4 — Crowding filter (strategy #6)

- **Crowding vetoes only NEW-LONG entries.** The over-recommended (crowded)
  signal is a _long_ signal — everyone is already in the trade — so the filter
  runs after `buildProposal` (side is known) and vetoes only `side === "long"`
  proposals with reason code `CROWDED_TICKER`. Shorts and exits pass untouched.
  Moving `buildProposal` ahead of the crowding + risk gates was the enabling
  change (AC: "proposal on a crowded ticker vetoed with reason CROWDED_TICKER").
- **The filter is a thin DB read; the store is the source of truth.**
  `DrizzleCrowdingFilter.check(ticker)` returns `{crowded, evidence?}` from the
  most-recent non-expired `crowded_tickers` row (`expires_at > now`). Reads only
  — the nightly job owns writes. Evidence flows into the veto journal entry.
- **The nightly job is a full replace → idempotent by construction.**
  `CrowdingRefreshService.refresh()` asks the researcher for the current crowded
  set and rewrites `crowded_tickers` inside one transaction (delete-all →
  insert), stamping a 30-day expiry. Running it twice converges to the same set,
  no duplicates (AC: "nightly job manually runnable and idempotent"). Tickers are
  upper-cased + de-duped (first evidence wins) before insert.
- **Research is behind an interface, defaulting to null offline.**
  `CrowdingResearcher` has an Anthropic impl (Claude + server-side web_search,
  JSON-schema-constrained output: which US equities are over-recommended right
  now, with one-line evidence) and a `NullCrowdingResearcher` (returns none).
  The DI factory picks Anthropic only when `ANTHROPIC_API_KEY` is set, so CI /
  offline runs never touch the network. Any transport error propagates — the
  caller keeps the previous set rather than blanking the store on a bad run.
- **Stop-tightening is advisory, not auto-applied.** `suggestCrowdingStops`
  scans open long positions with a stop on crowded names and emits a `modify-stop`
  suggestion that halves remaining risk (stop moved halfway to entry, cent-rounded,
  never loosened). These are journalled for the operator, not executed — strategy
  #6 runs WATCH-only and tightening a live stop is a human call.
- **Manual trigger via the dev surface.** `POST /dev/crowding/refresh` (gated by
  `DEV_TRIGGER_ENABLED`, same as the T1.9 trigger) runs the job on demand and
  returns the resulting ticker set + expiry — the "manually runnable" half of the
  AC without waiting on a scheduler.
- Full gate green: api 142 tests (+9: crowding refresh 4, filter 2, pipeline
  crowd-veto + suggest-stops, dev refresh 2); typecheck/eslint/prettier + all
  package builds + Next.js build.

## T2.5 — Strategy #1 — Earnings fade

- **The earnings calendar is a strategy-construction dependency, not new
  pipeline infra.** `CalendarProvider` (`recentEarnings(asOf)`) is injected into
  `EarningsFadeStrategy`; the default `StaticCalendarProvider` is empty in prod
  and seeded in tests. This keeps the strategy self-contained and fully
  deterministic under fixtures — no new DB table, no clock, no I/O in the domain
  package. Same shape as the crowding researcher (interface + null/static default).
- **Source choice (documented per build note): Financial Modeling Prep earnings
  calendar** (free tier, `/api/v3/earning_calendar`), filtered to a configurable
  retail-favourites watchlist. The live FMP adapter + nightly wiring are deferred
  (document-and-defer): the AC is fixture/dry-run driven, the strategy consumes
  the calendar purely through its injected provider, and adding a fetch adapter is
  a self-contained follow-up that needs no changes to the strategy. Simplest path
  first — ship the deterministic core now, wire the network source when scanning
  goes live.
- **Detector is pure OHLC math (`detectPostEarningsStall`).** The setup: a genuine
  miss/guide-down punishes the stock on the reaction session, then a dip-buy bounce
  over the next 2–3 sessions _stalls below the reaction-day high and closes red_.
  A qualifying stall bar (a) pokes above the prior + reaction close (a real bounce
  attempt), (b) stays capped below the post-earnings high, (c) closes red. Straight
  continuation-down days and bounces that reclaim the high both return null.
  Fixture-driven tests cover both trigger and every rejection path.
- **Modelled as `side:"short"` because the platform models only long/short
  equity.** The real expression of the fade is long puts (options-gated); since the
  domain has no options, `buildProposal` frames it as an equity short with the stop
  just above the reaction high and the target a measured move below the stall close,
  and writes the do-not-buy / long-puts framing into the exit-plan rules. Seeded
  `recommendedMode: WATCH` — in a long-only account this is primarily a
  do-not-buy filter, journalling "don't buy this dip" rather than trading.
- **LLM gate confirms the fundamental, never the numbers.** `llmPrompt` (web-search
  enabled) asks Claude to verify the report was an actual miss/guide-down — not a
  beat that merely dipped — and answer proceed/veto; all prices/levels come from the
  pure detector.
- Full gate green: strategies 31 tests (+13 over the pre-T2.5 baseline of 18:
  stall detector 7, earnings-fade strategy 6); typecheck/eslint/prettier + all
  package builds + Next.js build + api 142.

## T2.6 — Strategy #2 — Hype momentum

- **Two injected data sources, both static by default.** `HypeCandidateProvider`
  (`candidates(asOf)`) supplies the trending / most-bought / unusual-volume
  watchlist to scan; `EarningsSchedule` (`nextEarningsDate(ticker, asOf)`) supplies
  forward-looking earnings dates for the hard earnings-block. Kept separate from the
  T2.5 calendar because that returns _recent_ reporters while the block needs
  _upcoming_ dates. Both default to inert static impls so the strategy is
  deterministic offline; live feeds are a self-contained follow-up (same
  document-and-defer as T2.5's FMP calendar).
- **Fires once, on the fresh breakout bar (day 1).** `detectHypeSpike` only inspects
  the last bar: an up-day whose volume ≥ `volSpikeMult`× (default 2.5) the 20-day
  average and whose close clears the prior-20-day high. Firing solely on the last bar
  makes it a once-per-spike trigger (QUAL/SPHB fresh-cross analog) — no duplicate
  signals on day 2+ while the move persists. The spec's "day 1–2 of spike" is about
  when it's OK to _enter_; the signal itself is day-1.
- **Exit logic is a pure, priority-ordered function (`hypeExitDecision`).** Extracted
  from `manage` so every rule is unit-testable without a MarketContext (AC:
  "exit-rule unit tests incl. the earnings-block"). Priority: (1) HARD exit before
  any upcoming earnings date within the block window (default 3 days) — never hold a
  hype name into the print; (2) momentum stall — first heavy-volume red day
  (distribution); (3) momentum stall — a lower high that rolls over; (4) written
  exit — close below the 5-day MA. `scan` caches a `HypeView` per candidate (for
  _every_ inspected ticker, not just those that signalled) so `manage` reads it
  synchronously, same sync-manage contract as the other strategies.
- **"Half at +15%" is the bracket target; the rest lives in manage.** The domain
  models a single take-profit price, so the proposal target = entry·1.15 (the first
  half) and the exit-plan rules spell out the remainder rules (5-day-MA break,
  stall, earnings-block) that `manage` enforces on the balance.
- **LLM gate confirms catalyst + early-stage, never the numbers.** `llmPrompt`
  (web-search) asks Claude to verify a real, fresh catalyst and that the move is
  early-stage — not a late/parabolic blow-off — and answer proceed/veto.
- Full gate green: strategies 53 tests (+22 over T2.5's 31: spike detector +
  exit rules 15, fixtured spike-week replay 7); typecheck/eslint/prettier + all
  package builds + Next.js build + api 142.

## T2.7 — Strategy #7 — Friday→Monday flow

- **Week boundaries come from an injected calendar, not the weekday alone.** A
  `TradingCalendar(holidays, halfDays)` derives `isWeekCloseSession` /
  `isWeekOpenSession` by comparing the ISO week of the prev/next _trading_ day,
  so Good Friday shifts the week-close to Thursday, an MLK Monday shifts the
  week-open to Tuesday, and the half-day after Thanksgiving is still a valid
  week-close. Weekday-only logic would misfire on every holiday week. Half-days
  count as trading days. Calendar-edge tests cover all four cases (AC).
- **The trending / most-bought list is an injected `TrendingListProvider`** with
  a static default (same provider pattern as T2.5/T2.6). The live source
  (retail most-bought feed) is documented-and-deferred — the strategy is
  deterministic offline and the source swaps in without touching domain logic.
- **"Monday-open weakness ⇒ auto-cancel" is modeled two ways, both real.** The
  _pre-fill_ cancel is structural: entry is a **buy-stop above Friday's high**, so
  a weak Monday simply never triggers the bracket — no order management needed.
  The _post-fill_ cancel is a `manage()`-level exit (`flowExitDecision` rule 1)
  that flattens if Monday opens below Friday's close by `weakOpenPct`. Priority
  order: weak-open auto-cancel → mid-week strength target → end-of-week time
  stop; weak-open outranks a same-session strength spike (tested).
- **`priorWeekClose` is derived from the candle series via the calendar**, not
  persisted entry state: `scan` walks back for the most recent prior
  week-close session's close. Keeps `manage` a pure function of cached market
  data (sync-manage contract) with no cross-cycle position bookkeeping.
- Seed roster row stays `recommendedMode: APPROVE` — a confirmation-gated
  momentum trade, same posture as hype-momentum.
- Full gate green: strategies 71 tests (+18 over T2.6's 53: calendar/week
  helpers 7, flow signalling + Monday auto-cancel + exit rules 11);
  typecheck/eslint/prettier + all package builds + Next.js build + api 142.
