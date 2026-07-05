# infra

Docker Compose stack and infrastructure configs for the trading app.

## Services

| Service      | Image                               | Host port           | Purpose                                     |
| ------------ | ----------------------------------- | ------------------- | ------------------------------------------- |
| `postgres`   | `timescale/timescaledb:2.17.2-pg16` | `127.0.0.1:5432`    | Domain state + candles hypertable           |
| `redis`      | `redis:7-alpine`                    | `127.0.0.1:6379`    | BullMQ queues, pub/sub, kill-switch cache   |
| `ib-gateway` | `ghcr.io/gnzsnz/ib-gateway:stable`  | **none** (internal) | IB paper/live connectivity via IBC          |
| `api`        | built from `apps/api/Dockerfile`    | `127.0.0.1:3001`    | NestJS REST + WS + workers (profile `apps`) |
| `web`        | built from `apps/web/Dockerfile`    | `127.0.0.1:3000`    | Next.js dashboard (profile `apps`)          |

## Bringing it up

```bash
cp .env.example .env      # fill IB_USERNAME / IB_PASSWORD etc.
docker compose up -d      # data + broker layer (postgres, redis, ib-gateway)
docker compose ps         # wait for healthy states
```

Once the app images exist (T0.4 / T0.6):

```bash
docker compose --profile apps up -d   # full stack incl. api + web
```

## IB Gateway port mapping (important)

The `gnzsnz/ib-gateway` image runs the TWS API on `127.0.0.1:4001` (live) /
`4002` (paper) **inside** the container, then uses `socat` to republish those on
`0.0.0.0:4003` (live) / `0.0.0.0:4004` (paper). Consequences:

- Other compose services connect to **`ib-gateway:4004`** for the paper account
  (the `api` service sets `IB_GATEWAY_PORT=4004` accordingly). The `4002` in
  `.env.example` is the conceptual/native default and applies when connecting to
  a gateway running outside this compose network.
- The gateway has **no `ports:` mapping** — it is not published to the host, so
  it is reachable only from other containers on `trading-net`. This satisfies the
  T0.2 security requirement and spec §10.

## Health

- `postgres`: `pg_isready`
- `redis`: `redis-cli ping`
- `ib-gateway`: TCP check on the socat paper port (`4004`); `start_period` is
  150s because IBC login + gateway boot is slow. This proves the socat listener
  is up, not that a trading session is fully authenticated — the app's own
  gateway-status healthcheck (T0.4 `/healthz`) confirms the live connection.

## Daily restart

IB Gateway restarts daily (`AUTO_RESTART_TIME`, default `11:59 PM` container TZ).
Broker-side bracket orders survive the gap; app workers reconnect with backoff
(T0.5). Schedule this window outside market hours. Full runbook in T3.6.
