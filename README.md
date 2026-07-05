# trading-app

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

## Status

Phase 0 — Foundation (in progress). See `TASKS.md`.
