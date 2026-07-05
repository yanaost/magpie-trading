# TASKS.md — AI Trading App implementation plan for Claude Code

> Companion to `ai-trading-app-spec.md` (keep both in repo root — read the spec before starting any phase). Work through tasks in order; each task lists acceptance criteria (AC). Do not start a task until the previous task's AC pass.

---

## Ground rules (apply to every task)

1. **TypeScript strict mode everywhere.** Node 22, `"strict": true`, no `any` in domain code.
2. **Monorepo** with pnpm workspaces (structure below). Shared domain types live in `packages/core` — never duplicated.
3. **Money-path code is sacred:** risk manager, execution port, order construction, and kill switch require unit tests before the task is done. Target ≥90% coverage on `packages/core` risk/order modules; everything else pragmatic.
4. **The LLM never touches numbers.** LLM output is schema-validated JSON with `verdict: "proceed" | "veto"`, confidence, reasoning. Malformed/timeout ⇒ veto. Sizing, stops, and order params come only from deterministic code.
5. **Every entry is a bracket** (parent + stop + optional take-profit) — in the simulator and at IB alike. A proposal without a stop is rejected in `RiskManager`, with a test proving it.
6. **No live trading in this plan.** `LIVE` target exists in types/config but the execution adapter must throw `LivePromotionLockedError` until manually unlocked in a future milestone. Add a test asserting this.
7. **Append-only audit log:** every state change on strategies, proposals, orders, positions, and risk events writes an `audit_log` row. No deletes anywhere in the money path.
8. Conventional commits; one commit per task minimum; CI (GitHub Actions) runs typecheck, lint, tests on every push from Phase 0 onward.
9. Secrets only via `.env` (never committed); provide `.env.example` and keep it current.
10. When a task is ambiguous, choose the simpler option, note the decision in `DECISIONS.md`, and continue.

## Repo structure

```
trading-app/
  package.json  pnpm-workspace.yaml  docker-compose.yml  .env.example
  ai-trading-app-spec.md  TASKS.md  DECISIONS.md
  packages/
    core/          # domain types, Strategy interface, RiskManager, ExecutionPort, fill models
    strategies/    # one folder per strategy plugin
  apps/
    api/           # NestJS: REST + WS gateway, workers (BullMQ), services
    web/           # Next.js dashboard
  infra/           # docker configs (ib-gateway, caddy), migration scripts
```

## Environment variables (`.env.example`)

```
DATABASE_URL=postgres://trader:trader@localhost:5432/trading
REDIS_URL=redis://localhost:6379
ANTHROPIC_API_KEY=
IB_GATEWAY_HOST=localhost
IB_GATEWAY_PORT=4002           # 4002 paper, 4001 live
IB_ACCOUNT_ID=                 # DU... paper account
IB_USERNAME=  IB_PASSWORD=     # consumed by ib-gateway container only
TELEGRAM_BOT_TOKEN=  TELEGRAM_CHAT_ID=
APP_AUTH_SECRET=
KILL_SWITCH_DAILY_LOSS_PCT=3
```

---

## Phase 0 — Foundation

**T0.1 Scaffold monorepo.** pnpm workspaces, ESLint + Prettier, tsconfig base, vitest, GitHub Actions CI (typecheck + lint + test).
AC: `pnpm -r build` and `pnpm -r test` pass on a fresh clone; CI green.

**T0.2 docker-compose: postgres (timescaledb image), redis, ib-gateway (`gnzsnz/ib-gateway`), api, web.** Healthchecks on all services; ib-gateway ports bound to the compose network only (not host-published).
AC: `docker compose up` brings everything healthy; `docker compose ps` shows healthy states; gateway reachable from api container only.

**T0.3 Database schema + migrations** (Drizzle). Tables per spec §7: `strategies, signals, llm_analyses, proposals, orders, fills, positions, risk_events, crowded_tickers, journal_entries, audit_log, sim_portfolios, candles` (candles as Timescale hypertable, composite key ticker+timeframe+ts).
AC: `pnpm db:migrate` from zero succeeds; a seed script inserts the 8 strategies from spec §3.2 with correct default mode/target (`WATCH+SIM` for all initially); hypertable confirmed via `\d+ candles`.

**T0.4 NestJS skeleton** in `apps/api`: config module (env validation with zod), pino logging, health endpoint `/healthz` reporting db/redis/gateway status, BullMQ wiring, WebSocket gateway stub.
AC: `/healthz` returns per-dependency status; a demo repeating job logs every 30s.

**T0.5 IB market data adapter** using `@stoqey/ib`: connect/reconnect loop with backoff, subscribe real-time bars for a config list of tickers, request historical daily+5min candles, write to `candles`. Respect pacing: request queue with configurable rate, exponential retry on pacing violations.
AC: with paper gateway running, `pnpm ingest:backfill --tickers QUAL,SPHB,SPY --days 400` fills daily candles; live bars appear during market hours (or a recorded-fixture test proves the parsing path off-hours); disconnect/reconnect test passes (kill gateway container, adapter recovers, logs the gap).

**T0.6 Bare dashboard** in `apps/web`: auth (single user, session cookie from `APP_AUTH_SECRET` login), one page showing gateway status, candle counts per ticker, and a placeholder strategy list from the API.
AC: login works; page reflects live `/healthz` over WebSocket.

**Phase 0 done when:** fresh machine → `docker compose up` + backfill → dashboard shows healthy system with data.

---

## Phase 1 — One strategy end-to-end in SIM (QUAL/SPHB)

**T1.1 Domain core (`packages/core`).** Implement types/interfaces from spec §3.1: `Strategy`, `QuantSignal`, `TradeProposal`, `Mode`, `ExecutionTarget`, `RiskParams`, and `ExecutionPort` (place/modify/cancel bracket, fetch positions/fills — same interface for SIM and IB later).
AC: types compile; JSDoc on every exported symbol; zod schemas for all payloads that cross process/db boundaries.

**T1.2 RiskManager.** Deterministic checks per spec §5: per-trade risk 1–2%, max 5 positions / 2 per strategy / 1 per ticker, 6% total open risk, mandatory stop, no averaging down, daily loss counter that trips the kill switch, defined-risk-only options guard (types now, options math in Phase 3).
AC: table-driven unit tests for every rule, including the exact rejection reason string persisted to `risk_events`; kill-switch trip test at −3% day P&L.

**T1.3 Kill switch service.** Global flag in db + redis cache; when tripped (manually or by RiskManager): block all new orders, set all strategies to `WATCH`, notify. Re-arm endpoint requires typed confirmation string.
AC: integration test — trip switch, assert a pending proposal cannot execute, assert strategies demoted, assert audit rows.

**T1.4 Simulator (`ExecutionPort` impl).** Virtual portfolio per strategy instance (`sim_portfolios`); fill model per spec §4.4: fills at bid/ask (use last candle close ± half-spread estimate when quotes unavailable), configurable slippage (default 5 bps), IB commission model; bracket semantics — stop and target monitored against incoming bars, one-cancels-other.
AC: property tests — a bracket long fills, then either stop or target closes it, never both; portfolio cash/position accounting balances to the cent across 1,000 random simulated trades; reset endpoint zeroes a sim portfolio and audits it.

**T1.5 LLM analyst service.** Anthropic API client (model configurable, default a current Sonnet-class model), web search tool enabled; prompt template per strategy from `Strategy.llmPrompt`; response forced to JSON schema (`verdict, confidence, reasoning, flagged_risks[]`); 30s timeout and any parse failure ⇒ veto; persist everything to `llm_analyses` including latency and raw response.
AC: unit tests with mocked API for proceed/veto/timeout/garbage-output paths (all but proceed ⇒ veto); one live smoke test script (manual, not CI).

**T1.6 Signal pipeline orchestrator.** BullMQ flow implementing spec §4.2: scheduler tick → `scan` → LLM → crowding filter hook (no-op for now) → RiskManager → mode gate (`AUTO` executes via port, `APPROVE` persists proposal + notifies, `WATCH` logs) → position monitor loop calling `Strategy.manage` on each bar.
AC: integration test with a stub strategy driving a signal through every mode branch; expired proposals transition to `expired` and audit.

**T1.7 Strategy #3 — QUAL/SPHB pair (packages/strategies/qual-sphb).** Weekly scan: compute SPHB/QUAL ratio from candles, 20-week SMA, trigger when ratio > SMA by configurable threshold AND weekly ratio momentum turns down; proposal: long QUAL (short-SPHB leg flagged but disabled by default), stop and exit-at-mean rules; `manage`: exit when ratio reverts to SMA.
AC: unit test on synthetic candle fixtures reproducing a known trigger; replaying the last 2 years of real backfilled candles produces at least the historically expected trigger points (document them in the test).

**T1.8 Approval flow.** REST per spec §8 (`GET /proposals`, approve/reject with optional downward-only size modification) + Telegram bot mirroring proposal cards with inline Approve/Reject; WS channel `proposals` pushes to dashboard.
AC: e2e test approving via API executes a SIM bracket; Telegram flow verified manually and documented in README.

**T1.9 Dashboard v1.** Strategy tab for #3 per spec §3.3: header (mode + target selectors, badges, P&L sparkline), pending approvals, open positions with distance-to-stop, signal log including veto reasons, config panel. Global: kill switch button (confirm modal), portfolio bar, journal page.
AC: full loop demo — flip #3 to `APPROVE+SIM`, trigger a synthetic signal (dev-only trigger endpoint), approve in UI, watch the sim position live, see the journal entry.

**Phase 1 done when:** the demo in T1.9 works end-to-end and all core tests pass.

---

## Phase 2 — Real execution path + strategy roster

**T2.1 IB execution adapter (`ExecutionPort` impl).** Bracket orders via `@stoqey/ib` against the paper account; order-state machine mapped to our `orders` statuses; fill and commission capture; startup reconciliation (fetch broker open orders/positions, diff vs db, alert on mismatch); gateway daily-restart resilience (graceful reconnect window, brackets live broker-side per spec §4.3).
AC: paper-account integration script places and cancels a tiny bracket outside strategy flow; reconciliation test detects a manually placed rogue order; `LIVE` target throws `LivePromotionLockedError` (rule 6).

**T2.2 Promotion gates.** Per-strategy trade counters per target; `PATCH /strategies/:id` target change validates the gate (≥30 closed trades at current rung) and requires an attached review note; demotion always allowed; all audited.
AC: unit tests for gate math; e2e — attempt early promotion rejected with reason.

**T2.3 Strategy plugin loader + tabs UI.** Dynamic registration of everything in `packages/strategies`; dashboard renders one tab per registered strategy with the full §3.3 layout; per-strategy performance module (win rate, avg R, max drawdown, equity curve) computed from closed positions, split by execution target.
AC: adding a dummy strategy folder makes a functioning tab appear with zero UI code changes.

**T2.4 Crowding filter (strategy #6) as pipeline middleware.** Nightly job: LLM with web search compiles the currently over-recommended tickers into `crowded_tickers` (with evidence text, 30-day expiry); pipeline hook vetoes new-long proposals on crowded names and emits a tighten-stop `ExitAction` suggestion for open positions.
AC: pipeline test — proposal on a crowded ticker vetoed with reason `CROWDED_TICKER`; nightly job manually runnable and idempotent.

**T2.5 Strategy #1 — Earnings fade.** Nightly job pulls this week's earnings calendar (pick one free source; wrap in a `CalendarProvider` interface, document choice in DECISIONS.md) filtered to a configurable retail-favorites watchlist; post-report logic: day-2/3 bounce-stall detection below post-earnings high; default long-only account behavior = "do-not-buy filter" + long puts proposal when options permissions enabled; LLM verifies genuine miss/guide-down.
AC: fixture-driven tests for the stall detector; a WATCH-mode dry run over one real historical earnings week produces sensible journal entries.

**T2.6 Strategy #2 — Hype momentum.** Scan: volume ≥ 2–3× 20-day average on day 1–2 of spike + price above resistance; LLM verifies real catalyst and early-stage; proposal with pre-written exits (half at +15%, remainder on close below 5-day MA — configurable); `manage` implements momentum-stall exit (first heavy-volume red day / lower high); hard rule: exit before any earnings date.
AC: exit-rule unit tests incl. the earnings-block; replay over a fixtured spike week.

**T2.7 Strategy #7 — Friday→Monday flow.** Friday scan of trending/most-bought list (same `Provider` pattern as T2.5) closing near weekly highs; Monday-open weakness ⇒ auto-cancel; mid-week exit into strength.
AC: calendar-edge tests (holidays, half days); cancel-on-weak-open test.

**T2.8 Strategy #8 — Valuation gravity (WATCH-only).** Watchlist config of 5 retail darlings; tracks P/S vs a peer, sets earnings alerts, journals the two weeks after each report automatically.
AC: produces journal entries in replay over a past quarter; has no order-placement code path at all (assert via type: its proposals are `never`).

**Phase 2 done when:** #3 runs on IB paper via the gate; #1, #2, #7 run in `APPROVE+SIM`; #6 filters everything; #8 journals; tabs UI complete.

---

## Phase 3 — Automation + polish tooling

**T3.1 Replay engine.** Feed historical candles through the live pipeline at 1×–60×; deterministic clock injection everywhere (`ClockPort`); LLM calls in replay served from `llm_analyses` cache when the same signal context exists, else stub with configurable pass-rate and a `REPLAY_STUBBED` flag on results.
AC: replaying the same day twice yields identical trades (determinism test); an intraday session replays in under a minute at 60×.

**T3.2 Strategy #5 — Snapback (intraday).** Pre-market scan: $300M–$2B caps down ≥10%; LLM news check is the gate (earnings/dilution/lawsuit ⇒ veto — this is the highest-stakes LLM call, log verbosely); entry on higher-low + opening-range-low reclaim with rising volume after a 30–60 min wait; stop below day low; target half-gap-fill; **forced flatten before close** (broker-side time condition + app-side enforcement).
AC: replay across ≥10 fixtured historical gap-down sessions; forced-flatten test proves no overnight SIM position can exist.

**T3.3 Strategy #4 — Squeeze scalp (intraday).** Nightly short-interest ingestion (external source behind `ShortInterestProvider`); catalyst-day trigger: news + resistance break on volume; tight stop (2–4%), scaled partial exits same/next day; chase guard: no entry if already +30% on the day.
AC: chase-guard and partial-exit unit tests; replay over fixtured squeeze days.

**T3.4 AUTO mode hardening.** Enable `AUTO+SIM` for #4/#5: per-strategy daily trade caps, cooldown after N consecutive losses (auto-demote to APPROVE), notification on every auto entry/exit.
AC: chaos test — feed a pathological whipsaw day in replay, assert caps and cooldown demote the strategy instead of bleeding.

**T3.5 Variants + backtest reports.** Multiple SIM instances per strategy with parameter overrides shown as comparable rows in the tab; full-speed backtest runner producing the §4.4 report (equity curve, win rate, avg R, max DD, veto stats) as a stored artifact viewable in UI; promotion-gate review screen renders these reports.
AC: run snapback with two wait-time variants over 3 replay months, compare in UI; backtest results carry the `REPLAY_STUBBED` LLM caveat visibly.

**T3.6 Ops hardening.** Caddy TLS config, Tailscale deployment notes, encrypted nightly pg_dump off-box, uptime alerts (gateway down / worker stalled / queue backlog) to Telegram, `infra/README.md` runbook covering the IB daily-restart window.
AC: restore drill from a backup documented and performed once; alert fires when gateway container is stopped.

**Phase 3 done when:** #4/#5 run `AUTO+SIM` safely, replay/variant tooling is the daily polish loop, and the system is deployable to the VPS via the runbook.

---

## Definition of done (project-wide)

- All AC pass, CI green, no `LIVE` code path unlocked.
- README covers: setup from zero, paper account + market data subscription prerequisites, Telegram bot setup, the SIM→PAPER→LIVE ladder, and the kill switch.
- `DECISIONS.md` records every judgment call made along the way.
