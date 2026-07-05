# Personal AI Trading App — Architecture & Specification

**Version:** 0.1 (MVP spec) · **Owner:** Yana · **Date:** July 2026
**Scope:** Stocks, ETFs and options via Interactive Brokers · Mixed timeframes (intraday → multi-week) · TypeScript stack

---

## 1. Overview

A self-hosted web application that runs a portfolio of named trading strategies against an Interactive Brokers account. Each strategy is a pluggable module with its own quantitative rules, LLM analysis step, risk parameters, and **operating mode**. The UI presents each strategy as a tab, so every strategy has its own home: signals, pending approvals, open positions, performance, and configuration.

**MVP goal:** one strategy running end-to-end in the built-in **simulator** (virtual money, real pipeline), then promoted to the IB **paper account**, expanding strategy-by-strategy. Every strategy climbs the same ladder — SIM → PAPER → LIVE — and live trading is unlocked per strategy only after gated, reviewed results at each rung.

**Non-goals for MVP:** multi-user support, mobile app (responsive web only), high-frequency execution, crypto/futures.

---

## 2. Operating modes

Modes are set **per strategy**, not globally, and the architecture keeps room for future modes.

| Mode | Behavior |
|---|---|
| `AUTO` | Signals that pass LLM analysis and risk checks are executed automatically. Every trade still logged and notified. |
| `APPROVE` | Full trade proposal (entry, size, stop, target, LLM reasoning) is sent to you; executes only on your explicit approval. Proposals expire after a configurable TTL (default: 15 min intraday, end-of-day for swing). |
| `WATCH` (future-ready, trivial to include in MVP) | Signals and analysis are generated and logged, no orders. Used for incubating new strategies and for observation-type strategies. |
| `OFF` | Strategy loaded but idle. |

### 2.1 Execution targets (orthogonal to modes)

Independently of its mode, each strategy points at one of three execution targets — the promotion ladder every strategy climbs:

| Target | What it is | Use |
|---|---|---|
| `SIM` | Built-in simulator: virtual cash per strategy, fills modeled in-app against live quotes or replayed historical data. No IB order ever placed. Instant resets, multiple parallel variants of one strategy, works after hours via replay. | Polish and tune a strategy without money; A/B test parameter changes. |
| `PAPER` | IB paper account through the real Gateway and real order types. | Validate the full pipeline — brackets, fills, pacing, reconnects — under realistic conditions. |
| `LIVE` | Real account. | Only after passing the promotion gates below. |

Any mode combines with any target: `AUTO + SIM` is the polishing workhorse (the strategy trades virtual money by itself while you watch its journal), `APPROVE + SIM` lets you practice your own approval judgment risk-free.

**Promotion gates:** SIM → PAPER after a configurable minimum of simulated trades with a reviewed report (default 30); PAPER → LIVE after the same on paper. Demotion is one click, and the kill switch drops everything to SIM-or-WATCH.

A global **kill switch** overrides everything: one click flattens nothing by itself (safety: it never auto-sells unless you confirm) but instantly blocks all new orders and downgrades every strategy to `WATCH`.

---

## 3. Strategy framework

### 3.1 Strategy as a plugin

Every strategy implements a common TypeScript interface:

```ts
interface Strategy {
  id: string;                          // "earnings-fade"
  name: string;
  timeframe: "intraday" | "swing" | "weekly";
  defaultMode: Mode;                   // AUTO | APPROVE | WATCH | OFF
  universe(ctx: MarketContext): Promise<Ticker[]>;   // what to scan
  scan(ctx: MarketContext): Promise<QuantSignal[]>;  // quant rules
  llmPrompt(signal: QuantSignal): AnalysisRequest;   // what the LLM must verify
  buildProposal(signal: QuantSignal, analysis: LLMAnalysis): TradeProposal; // entry, size, stop, target, exit rules
  manage(position: Position, ctx: MarketContext): ExitAction | null; // ongoing exit logic
  riskParams: RiskParams;              // per-strategy overrides
}
```

Key principle carried over from our strategy work: **the exit is written before the entry**. `buildProposal` must always return a stop-loss and an exit plan; the risk manager rejects proposals without them.

### 3.2 The strategy roster (from our earlier frameworks)

| Tab | Strategy | Timeframe | Recommended MVP mode | LLM analyst's job |
|---|---|---|---|---|
| 1 | **Earnings fade** — retail favorites drifting down after a miss; short / puts / avoid-filter on day 2–3 stall | Swing (1–2 wks) | `APPROVE` | Confirm the report was a genuine miss/guide-down; classify news severity |
| 2 | **Hype momentum** — early volume-spike entries with pre-written exits | Days | `APPROVE` | Verify a real catalyst exists and the move is day 1–2, not late-stage |
| 3 | **QUAL/SPHB pair** — mean reversion when high-beta/quality ratio is stretched and turning | Weekly | `APPROVE` (good first live candidate — slow and safe) | Sanity-check macro regime; flag stress events |
| 4 | **Squeeze scalp** — >20% short interest + catalyst breakout; fast partial exits | Intraday | `AUTO` (with tight caps) — speed matters | Validate the catalyst is real news, not a pump |
| 5 | **Snapback** — small caps down 10%+ on *no fundamental news*; higher-low reclaim entry, flat by close | Intraday | `AUTO` (with tight caps) | The critical "is there real bad news?" check — earnings, dilution, lawsuits → veto |
| 6 | **AI-crowding filter** — the month's over-recommended tickers | — (filter) | Always on | Maintain the crowded-tickers list from news/recommendation scans; runs as a **pre-trade veto/tighten layer over all other strategies** |
| 7 | **Friday→Monday flow** — trending names closing the week strong | Week | `APPROVE` | Confirm the name is genuinely in top retail-flow lists |
| 8 | **Valuation gravity watchlist** — expensive retail darlings around earnings | Observation | `WATCH` | Post-earnings drift commentary; feeds the journal, never trades |

Strategy #6 is architecturally different: it registers as a **filter middleware** in the decision pipeline rather than a signal generator. Any proposal touching a crowded ticker is either vetoed (new longs) or gets tightened stops (existing positions).

### 3.3 Strategy tabs — UI spec

Each tab contains, top to bottom:

1. **Header:** strategy name, mode selector (AUTO / APPROVE / WATCH / OFF), paper/live badge, P&L sparkline.
2. **Pending approvals** (APPROVE mode): proposal cards showing ticker, direction, size, entry, stop, target, risk in $ and % of account, the quant trigger, and the LLM's reasoning — with Approve / Reject / Modify-size buttons and a countdown to expiry.
3. **Open positions:** live P&L, distance to stop, current exit rule state, "close now" button.
4. **Signal log:** recent scans, including signals vetoed by the LLM or risk manager and *why* (this is where you learn).
5. **Performance:** win rate, avg R-multiple, max drawdown, equity curve — per strategy.
6. **Config:** universe filters, risk overrides, schedule.

Global elements outside the tabs: portfolio summary bar, notifications center, kill switch (always visible, red, requires confirm), and a journal view aggregating every decision across strategies.

---

## 4. Architecture

### 4.1 Components

| Component | Responsibility | Tech |
|---|---|---|
| **Web dashboard** | Strategy tabs, approvals, portfolio, journal, kill switch | Next.js (React), WebSocket client |
| **API server** | REST + WebSocket gateway, auth, orchestration | NestJS |
| **Strategy engine** | Runs each strategy's `universe`/`scan`/`manage` on schedules; computes indicators | NestJS worker, BullMQ jobs, `technicalindicators` / custom TS |
| **LLM analyst** | Structured analysis calls per signal; crowding-list maintenance; returns JSON verdicts | Anthropic API (Claude), web search tool enabled |
| **Risk manager** | Validates every proposal against global + per-strategy limits; owns the kill switch | Pure TS module in the order path (not bypassable) |
| **Execution service** | Approval gate, order construction (brackets), routing, fill tracking, reconciliation | `@stoqey/ib` (IB TWS API client for Node) |
| **Simulator** | Virtual fills, per-strategy virtual portfolios, historical replay & backtest runner | Pure TS fill engine implementing the same `ExecutionPort` interface as the Execution service |
| **IB Gateway** | Broker connectivity, market data, paper/live session | Dockerized IB Gateway + IBC auto-login (e.g. `gnzsnz/ib-gateway` image) |
| **Data layer** | Persistent state, audit log, candles; job queue and pub/sub | PostgreSQL (+ TimescaleDB extension for candles), Redis + BullMQ |
| **Notifier** | Approval pushes and alerts | Telegram bot (simplest reliable push) + web push; email fallback |

### 4.2 Signal lifecycle (the core data flow)

```
scheduler tick (per strategy, per timeframe)
  → Strategy.scan() over market data          [quant trigger]
  → LLM analyst: structured verdict            [context check: news, catalyst, veto]
  → Crowding filter (strategy #6)              [veto / tighten]
  → Risk manager: sizing + limit checks        [reject or finalize proposal]
  → mode gate:
      AUTO    → Execution service places bracket order
      APPROVE → proposal persisted + push notification → user decision → execute or expire
      WATCH   → log only
  → position monitoring loop: Strategy.manage() enforces exits
  → fills, P&L, and every decision (incl. rejections) → audit log + journal
```

The LLM returns **structured JSON only** (verdict: proceed/veto, confidence, reasoning, flagged risks), validated against a schema. A malformed or timed-out LLM response is treated as a **veto**, never a pass. The LLM never sizes positions and never touches order parameters — that is exclusively the risk manager's deterministic code.

### 4.3 Exit enforcement — two layers

1. **Broker-side:** every entry is placed as a bracket order (parent + stop-loss + take-profit) so exits survive app crashes and gateway restarts.
2. **App-side:** `Strategy.manage()` handles the smarter exits (trailing under 5-day MA, "flat by close", partial profit-taking, momentum-stall rules) by modifying the bracket.

If the app loses connection to IB Gateway, broker-side stops remain live — this is non-negotiable in the design.

### 4.4 Simulation & replay (the "trade without money" layer)

The simulator sits behind the same `ExecutionPort` interface as real execution, so strategies cannot tell the difference — the entire pipeline (quant scan → LLM verdict → crowding filter → risk manager → approval gate) runs identically; only the fill source changes.

- **Live-sim:** fills modeled against real-time quotes during market hours. Fill model is deliberately pessimistic: fills at bid/ask (not mid), configurable slippage (default 0.05% equities, wider for options), commissions applied at IB's rates. Optimistic fill models are how simulated strategies die in production.
- **Replay:** the candle store plays back any historical date range at 1×–60× speed. This is the fast iteration loop — an intraday strategy can be run against dozens of past sessions in one evening, including specific interesting days (earnings weeks, selloffs).
- **Backtest:** same engine at full speed over months of data, producing the standard report (equity curve, win rate, avg R, max drawdown, per-rule veto stats). LLM calls in backtests are replayed from cache where available or stubbed with a configurable pass rate, since historical news context can't be fully reconstructed — backtest results are treated as directional, replay and live-sim as the real evidence.
- **Variants:** one strategy can run several SIM instances with different parameters side by side (e.g. snapback with 30 vs 60 minute wait); the tab shows them as comparable rows.
- Virtual portfolios are isolated per strategy instance, resettable in one click, and everything writes to the same journal and performance analytics as real trading — polishing produces the exact evidence the promotion gate reviews.

Options in SIM are filled off the real chain's bid/ask with a wider slippage assumption; illiquid contracts (failing the open-interest/spread filters) are rejected in SIM exactly as they would be by the risk manager live.

---

## 5. Risk management

Global limits (risk manager, hard-coded checks — config can tighten but not exceed):

- Max risk per trade: **1–2% of account equity** (stop distance × size).
- Max concurrent positions: 5 total; max 2 per strategy; max 1 per ticker across strategies.
- Max total open risk: 6% of equity.
- **Daily loss limit:** −3% of equity → kill switch trips automatically (no new orders, all strategies → WATCH, notification sent).
- Options-specific: defined-risk positions only for MVP (long puts/calls, debit spreads); premium at risk counts as full loss for sizing; no naked short options; min open interest and max spread-width filters.
- No averaging down, ever — rejected at the risk layer.
- Intraday strategies (#4, #5): no overnight holds; forced flatten window before close.
- Promotion gates: a strategy may only move SIM → PAPER, and PAPER → LIVE, after N trades at the current rung (default 30 each) and a reviewed performance report.

Every risk rejection is logged with the rule that fired — visible in the strategy tab's signal log.

---

## 6. Tech stack summary

- **Language:** TypeScript end-to-end (Node 22).
- **Backend:** NestJS (API + workers), BullMQ on Redis for scheduling/queues.
- **Frontend:** Next.js + React, Tailwind, `lightweight-charts` (TradingView's OSS lib) for price/equity charts, WebSocket for live updates.
- **Broker:** `@stoqey/ib` against IB Gateway (Docker, IBC for auto-login and the daily-restart dance).
- **AI:** Anthropic API (Claude) with tool use for news search; JSON-schema-validated outputs.
- **DB:** PostgreSQL 16 + TimescaleDB hypertables for candles; Prisma or Drizzle ORM.
- **Deploy:** Docker Compose. Develop locally; production on a small VPS (2 vCPU / 4 GB, e.g. Hetzner CX22 or DO droplet) in a region near IB's servers. Caddy reverse proxy with TLS.
- **Observability:** pino structured logs, health checks on the gateway connection, uptime alert to Telegram if the gateway or workers die.

---

## 7. Data model (core tables)

- `strategies` — id, mode, config JSON, live/paper flag, risk overrides.
- `signals` — strategy_id, ticker, trigger payload, quant metrics, created_at.
- `llm_analyses` — signal_id, verdict, confidence, reasoning, raw response, latency, model.
- `proposals` — signal_id, side, qty, entry, stop, target, exit_plan JSON, status (pending/approved/rejected/expired/executed), decided_by (user/auto), expiry.
- `orders` / `fills` — broker order ids, bracket linkage, status, reconciliation timestamps.
- `positions` — open/closed, avg price, realized/unrealized P&L, strategy_id.
- `risk_events` — rule fired, context, severity (incl. kill-switch trips).
- `crowded_tickers` — ticker, source evidence, added_at, expires_at (strategy #6's state).
- `sim_portfolios` — strategy_instance_id, variant params JSON, virtual cash, created/reset_at; sim fills reuse `orders`/`fills`/`positions` with a target column (`SIM`/`PAPER`/`LIVE`) so analytics work identically across rungs.
- `journal_entries` — auto-generated per decision + free-text notes from you.
- `candles` (Timescale hypertable) — ticker, timeframe, OHLCV.
- `audit_log` — append-only record of every state change; nothing that touches money is deletable.

---

## 8. API sketch

REST (NestJS, auth-protected):

- `GET /strategies` · `PATCH /strategies/:id` (mode, config)
- `GET /strategies/:id/signals|positions|performance`
- `GET /proposals?status=pending` · `POST /proposals/:id/approve|reject` (approve accepts optional size modification downward only)
- `POST /killswitch` · `DELETE /killswitch` (re-arm requires typed confirmation)
- `GET /portfolio` · `GET /journal` · `POST /journal/:id/note`

WebSocket channels: `proposals`, `positions`, `fills`, `alerts`, `gateway-status`.

Telegram bot mirrors the approval flow: proposal card with inline Approve/Reject buttons, so approvals work from your phone without opening the dashboard.

---

## 9. IBKR integration notes

- **Paper account first:** IB provides a paper account mirroring your live one; the gateway connects to either via config. All MVP work targets paper.
- **Gateway realities:** IB Gateway restarts daily and needs 2FA handling — IBC automates login; schedule the restart window outside market hours and have workers reconnect gracefully. Bracket orders on the broker side cover the gap.
- **Pacing limits:** IB throttles API requests (~50 msg/s, historical data pacing rules). The market-data layer must queue and cache; scanning universes should lean on IB's market scanner subscriptions plus a nightly universe refresh, not per-ticker hammering.
- **Market data subscriptions:** real-time US equities/options data requires paid subscriptions on the IB account (a few USD/month each); delayed data is unusable for intraday strategies #4/#5. Short-interest data isn't in IB's feed — pull from an external source (e.g. a Finviz-style screener export or a data API) in the nightly job.
- **Permissions:** strategies #1 and #4 involve shorting or options — the account needs options trading permissions and margin for shorts; the app must detect missing permissions and degrade those strategies to long-only/puts-only or WATCH.

---

## 10. Security

- Single-user system; dashboard behind authentication (passkey or OAuth) **and** ideally not on the public internet at all — Tailscale/WireGuard to the VPS is the recommended posture. IB Gateway ports bound to the internal Docker network only, never exposed.
- Secrets (IB credentials, Anthropic key, Telegram token) in an env vault (SOPS or Docker secrets), never in the repo.
- LLM output is untrusted input: schema-validate, never interpolate into order parameters, cap its authority at proceed/veto.
- Append-only audit log; daily encrypted DB backups off-box.

---

## 11. Build phases

**Phase 0 — Foundation (week 1–2):** Docker Compose skeleton, IB Gateway paper connection, market data ingestion into Timescale, portfolio read-out on a bare dashboard.

**Phase 1 — One strategy end-to-end in SIM (week 3–5):** Strategy #3 (QUAL/SPHB — slowest, safest) running the full pipeline into the **simulator**: scan → LLM verdict → risk check → Telegram approval → simulated bracket fill → position monitoring → journal. Kill switch, risk manager, and the simulator fill engine are built here, first — no IB order code yet, which makes this phase fast and safe.

**Phase 2 — Real execution path + roster (week 6–9):** Execution service against the IB **paper** account; promote strategy #3 SIM → PAPER through the gate. Strategy plugin loader, tabs UI, strategies #1, #2, #7 in `APPROVE + SIM`; #8 in WATCH; crowding filter #6 as middleware.

**Phase 3 — Automation + polish tooling (week 10+):** `AUTO` mode with the intraday pair #4/#5 in SIM, historical **replay** and variant comparison for tuning them, forced-flatten logic, per-strategy analytics, and the promotion-gate reports. Full backtest harness follows replay naturally.

---

## 12. Note on expectations

This system inherits the honest conclusion from the research the strategies came from: retail traders on average lose to institutional players, and what separates a structured approach from typical retail behavior is the boring machinery — fixed stops, small sizes, pre-written exits, and journaled decisions. That machinery is exactly what this architecture hard-codes so it can't be skipped in the moment. Nothing here is financial advice; the paper-first gate and per-strategy live approval exist so the system proves itself before real capital does.
