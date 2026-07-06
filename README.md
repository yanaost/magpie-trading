# magpie-trading

Personal AI trading app — a self-hosted portfolio of pluggable trading
strategies running against an Interactive Brokers account, with a built-in
simulator, deterministic risk manager, and LLM analyst (proceed/veto only).

See [`ai-trading-app-spec.md`](./ai-trading-app-spec.md) for the architecture
and [`TASKS.md`](./TASKS.md) for the implementation plan. Judgment calls are
logged in [`DECISIONS.md`](./DECISIONS.md).

> **No live trading.** The `LIVE` execution target is locked in code and throws
> until manually unlocked in a future milestone. All current work targets the
> built-in simulator and (later) the IB **paper** account.

## Repo layout

```
trading-app/
  packages/
    core/          # domain types, RiskManager, ExecutionPort, fill models
    strategies/    # one folder per strategy plugin
  apps/
    api/           # NestJS: REST + WS gateway, BullMQ workers
    web/           # Next.js dashboard
  infra/           # docker configs, migration scripts
```

## Prerequisites

**To run everything in SIM (the default) — no broker account needed:**

- Node 22 (Node 20.12+ works locally; CI pins 22)
- pnpm 9 (`corepack enable`)
- Docker + Docker Compose (for postgres/redis; the app itself can run on host Node)

**Additionally, to run against the IB _paper_ account (the PAPER rung):**

- An **Interactive Brokers account** with **paper trading enabled** (a `DU…`
  paper account id). Set `IB_ACCOUNT_ID`, `IB_USERNAME`, `IB_PASSWORD`, and
  `TRADING_MODE=paper` in `.env` — the credentials are consumed by the
  `ib-gateway` container, never by app code.
- **Market-data subscriptions** on that IB account for the symbols you trade
  (`MARKET_DATA_TICKERS`, default `QUAL,SPHB,SPY`). Without the subscription IB
  returns delayed/blank quotes and realtime bars won't flow. Live market data is
  off by default (`MARKET_DATA_ENABLED=false`); set it `true` to open the IB
  connection and stream bars at boot.
- The `ib-gateway` container publishes the paper API on port **4002**
  (`IB_GATEWAY_PORT`); live is 4001 and stays locked (see the ladder below).

SIM uses none of the above — quotes and fills come from the built-in simulator,
so you can exercise the entire loop with zero broker setup.

## Getting started

```bash
corepack enable
pnpm install
cp .env.example .env   # fill in secrets (none required for SIM)
pnpm -r build
pnpm -r test
```

For the full containerized stack (postgres + redis + ib-gateway + api + web),
see [`infra/README.md`](./infra/README.md) — it covers `docker compose
--profile apps up -d`, the IB gateway port mapping, the daily-restart window,
backups, and the deployment runbook.

## Scripts

| Command             | Description                   |
| ------------------- | ----------------------------- |
| `pnpm -r build`     | Build every workspace package |
| `pnpm -r test`      | Run all tests (vitest)        |
| `pnpm -r typecheck` | Typecheck every package       |
| `pnpm lint`         | ESLint across the repo        |
| `pnpm format`       | Prettier write                |

## Running the dashboard demo (Phase 1)

Bring up postgres + redis, migrate, seed, then run the API and web app:

```bash
docker compose up -d postgres redis     # or point .env at your own instances
pnpm db:migrate
pnpm db:seed
pnpm --filter @magpie/api dev            # API on :3001
pnpm --filter @magpie/web dev            # dashboard on :3000 (separate shell)
```

Sign in to the dashboard (credentials from `.env`). The **full-loop demo**
(T1.9 AC), all against the built-in SIM rung:

1. In the **Strategies** panel, set `QUAL/SPHB pair` to **APPROVE** + **SIM**.
2. Click **Trigger signal** on that row. This calls the dev-only endpoint
   `POST /dev/trigger/qual-sphb`, which seeds a SIM quote and injects a
   synthetic long-QUAL signal through the _real_ risk manager and mode gate —
   the LLM analyst and quant scan are bypassed, everything else is production.
3. The proposal appears under **Pending approvals** (also pushed to Telegram if
   configured). Click **Approve**.
4. The approved market bracket fills immediately against the seeded SIM quote —
   a live position shows up under **Open positions** with its distance-to-stop
   and the portfolio bar updates.
5. The decision trail (`Proposal awaiting approval` → `APPROVED executed …`)
   appears in the **Signal log** and the **Journal** page.

The dev trigger is gated by `DEV_TRIGGER_ENABLED` (defaults on outside
production). SIM positions are in-memory and reset when the API restarts.

The same loop over REST (no browser):

```bash
curl -X PATCH localhost:3001/api/strategies/qual-sphb -H 'content-type: application/json' -d '{"mode":"APPROVE","target":"SIM"}'
curl -X POST  localhost:3001/dev/trigger/qual-sphb   -H 'content-type: application/json' -d '{"entry":100}'
PID=$(curl -s localhost:3001/proposals | jq -r '.proposals[0].id')
curl -X POST  localhost:3001/proposals/$PID/approve  -H 'content-type: application/json' -d '{}'
curl -s localhost:3001/api/positions | jq          # QUAL long, live from the Simulator
curl -s localhost:3001/api/journal   | jq          # the decision trail
```

### Telegram approvals (optional)

Set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` in `.env`. Then a proposal in
`APPROVE` mode is delivered to the chat with inline **✅ Approve** / **❌ Reject**
buttons; pressing one routes straight into `PipelineService.decideProposal`
(same path as the REST/UI approve) and edits the message with the outcome.
Unset, the whole feature no-ops — dev/CI/SIM boot without a bot.

To create the bot: message [@BotFather](https://t.me/BotFather) → `/newbot` →
copy the token into `TELEGRAM_BOT_TOKEN`. Get your chat id by messaging the bot
once and reading `https://api.telegram.org/bot<TOKEN>/getUpdates`
(`result[].message.chat.id`), or use [@userinfobot](https://t.me/userinfobot).

## The SIM → PAPER → LIVE ladder

Every strategy instance has an **execution target**, and promotion up the ladder
is deliberate and gated:

| Target    | Fills come from                    | Account risk | How to reach it                                   |
| --------- | ---------------------------------- | ------------ | ------------------------------------------------- |
| **SIM**   | the built-in `Simulator` (virtual) | none         | default; set any time                             |
| **PAPER** | the IB **paper** account (`DU…`)   | fake money   | promote SIM→PAPER once the paper account is wired |
| **LIVE**  | the IB **live** account            | real money   | **locked in code** — throws `LivePromotionLocked` |

- Set a strategy's target from the dashboard **Strategies** panel or
  `PATCH /api/strategies/:id {"target":"SIM"|"PAPER"}`. The **promotion gate**
  classifies each change (promotion / demotion / no-op) and records it.
- **Risk sizing reads the target's real equity** (A0): SIM sizes against the
  strategy's virtual sim cash; PAPER sizes against the broker's net liquidation
  value. So a proposal's risk dollars are always ~1–2% of the account that would
  actually take the trade, not a fixed constant.
- `SIM→PAPER→LIVE` — any promotion **to LIVE is refused** regardless of trade
  count or note (ground rule 6). Unlocking LIVE is a future, manual milestone;
  there is no runtime flag for it.

## Kill switch

A global stop that blocks **all** new orders across every strategy and target,
independent of individual modes. It **fails safe**: if its own state store is
unreachable it reports ACTIVE, so an infra outage stops trading rather than
letting it run blind.

```bash
curl -s   localhost:3001/killswitch                              # current state
curl -X POST   localhost:3001/killswitch \
     -H 'content-type: application/json' -d '{"reason":"manual stop"}'   # TRIP
curl -X DELETE localhost:3001/killswitch \
     -H 'content-type: application/json' -d '{"confirmation":"RE-ARM TRADING"}'  # re-arm
```

Re-arming requires the exact typed phrase `RE-ARM TRADING` and deliberately does
**not** restore strategy modes — you re-enable each strategy consciously after
confirming the cause is resolved. The dashboard exposes the same trip/re-arm
controls.

## Status

Phases 0–3 complete (foundation, one strategy end-to-end in SIM, real execution
path + strategy roster, automation + polish tooling), plus A0 (real per-strategy
equity for risk sizing). `AUTO+SIM` runs safely with per-strategy caps and
loss-cooldown demotion; replay/variant tooling and backtest reports are in place;
the stack is deployable via [`infra/README.md`](./infra/README.md). LIVE remains
locked. Live PAPER round-trip verification is pending an IB paper account. See
[`TASKS.md`](./TASKS.md) and [`DECISIONS.md`](./DECISIONS.md).
