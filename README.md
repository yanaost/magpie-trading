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

- Node 22 (Node 20.12+ works locally; CI pins 22)
- pnpm 9 (`corepack enable`)
- Docker + Docker Compose (for postgres/redis/ib-gateway — Phase 0.2 onward)

## Getting started

```bash
corepack enable
pnpm install
cp .env.example .env   # fill in secrets
pnpm -r build
pnpm -r test
```

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

## Status

Phase 1 — Trading loop (T1.9 dashboard v1 complete: mode/target control, dev
trigger, approvals, live SIM positions, kill switch, signal log, journal). The
full-loop demo above is verified end-to-end. See `TASKS.md`.
