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
(T0.5). Schedule this window outside market hours. See the runbook below.

---

# Ops hardening (T3.6)

## Deployment posture: Tailscale first

The dashboard can place paper/live orders, so it must never sit open on the
public internet. The default and recommended posture is **Tailscale-only**:

1. Install Tailscale on the VPS and your laptop; join the same tailnet.
   ```bash
   curl -fsSL https://tailscale.com/install.sh | sh
   sudo tailscale up --ssh          # --ssh lets you reach the box over the tailnet
   ```
2. Do **not** open ports 3000/3001/80/443 to `0.0.0.0` in the cloud firewall.
   The compose ports already bind `127.0.0.1` only; reach them over the tailnet
   via the VPS's Tailscale IP (`tailscale ip -4`) or MagicDNS name
   (`magpie.<tailnet>.ts.net`).
3. Reach the dashboard at `http://magpie.<tailnet>.ts.net:3000`. No public DNS,
   no ACME, zero public attack surface.

Only if you need multi-user or off-tailnet access, front the stack with Caddy
(below) on a public hostname — **with basic-auth on**.

## Reverse proxy + TLS (Caddy)

`infra/Caddyfile` terminates HTTPS with automatic Let's Encrypt certs and proxies
`/api`, `/healthz`, `/proposals`, `/killswitch` → `api:3001` and everything else
→ `web:3000`. Basic-auth guards the whole site.

```bash
# Generate a bcrypt hash for the dashboard password:
caddy hash-password --plaintext 'your-strong-password'

# Provide env and run (as a sidecar container or host service):
export SITE_ADDRESS=magpie.example.com
export ACME_EMAIL=you@example.com
export DASH_USER=trader
export DASH_HASH='<hash from above>'
caddy run --config infra/Caddyfile
```

Add Caddy to compose as a service on `trading-net` publishing `80:80`/`443:443`;
keep `api`/`web` unpublished so they're reachable only through Caddy.

## Backup & restore

Encrypted, off-box, nightly. `infra/backup/pg_backup.sh` dumps Postgres
(custom format) → gzip → AES-256 (openssl, pbkdf2) and optionally pushes the
artifact off the box with `rclone`/`scp`. `infra/backup/restore.sh` reverses it.

The passphrase is read from `BACKUP_PASSPHRASE_FILE` (a root-only file) and never
appears in argv or on disk. **Store it in a password manager** — losing it makes
every backup useless.

Cron (nightly 03:15 UTC — outside US market hours and the IB restart window):

```cron
15 3 * * *  DATABASE_URL=postgres://trader:trader@localhost:5432/trading \
            BACKUP_DIR=/var/backups/magpie \
            BACKUP_PASSPHRASE_FILE=/root/.pgbackup.key \
            BACKUP_REMOTE=b2:magpie-backups \
            /opt/magpie/infra/backup/pg_backup.sh >> /var/log/pgbackup.log 2>&1
```

### Restore drill (AC — documented + performed)

Recovery is only real if it's been rehearsed. Run this against a **scratch**
database (never live) at least quarterly:

```bash
BACKUP_PASSPHRASE_FILE=/root/.pgbackup.key \
TARGET_DATABASE_URL=postgres://trader:trader@localhost:5432/trading_restore_drill \
DROP_AND_CREATE=true \
  infra/backup/restore.sh /var/backups/magpie/trading-<stamp>.dump.gz.enc

# Verify against expectations, then drop the scratch db:
psql "$TARGET_DATABASE_URL" -c "select count(*) from strategies;"
psql .../postgres -c "drop database trading_restore_drill;"
```

**Drill performed 2026-07-06** against a local Postgres 16 instance: seeded a
3-row `backup_drill` table into `trading`, ran `pg_backup.sh` (6432-byte
encrypted artifact), then `restore.sh` with `DROP_AND_CREATE=true` into
`trading_restore_drill`. Verification recovered all 3 rows with values intact
(`drill-row-A,drill-row-B,drill-row-C`). Scratch db and drill table dropped
afterward. The backup/restore path is proven end-to-end.

## Uptime alerts

The API runs a background monitor (`UPTIME_MONITOR_ENABLED=true`) that probes on
`UPTIME_CHECK_INTERVAL_MS` (default 60s) and pushes **edge-triggered** Telegram
alerts — one message when a condition trips, one when it clears, never a per-tick
flood:

| Alert            | Condition                                                        |
| ---------------- | ---------------------------------------------------------------- |
| `gateway-down`   | IB gateway TCP port unreachable (`/healthz` gateway probe down)  |
| `worker-stalled` | no BullMQ worker heartbeat within `UPTIME_WORKER_STALE_MS` (90s) |
| `queue-backlog`  | waiting+delayed jobs exceed `UPTIME_QUEUE_BACKLOG_MAX` (100)     |

Workers bump a shared Redis heartbeat key (`uptime:worker:heartbeat`) on every
job; the monitor reads its age. Requires `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID`
(without them the sink no-ops). To verify: `docker compose stop ib-gateway` and a
`gateway-down` alert should arrive within one interval; `start` it to get the
recovery message.

## Runbook — incident procedures

- **IB daily restart (expected).** ~`11:59 PM` container TZ, gateway drops for
  ~1–2 min. Broker-side brackets persist; workers reconnect with backoff. A
  transient `gateway-down` alert around this window is normal — only page a human
  if it doesn't self-recover within ~5 min.
- **Gateway down (unexpected).** Check `docker compose ps` / `logs ib-gateway`.
  IBC 2FA timeout is the usual cause; `RELOGIN_AFTER_TWOFA_TIMEOUT=yes` retries.
  Open positions are safe (broker-side brackets); no new entries place while the
  gateway is down.
- **Worker stalled.** `docker compose restart api`. Inspect the queue backlog
  first (`redis-cli -n 0 llen bull:demo:wait`) — a growing backlog with a stalled
  worker means the worker process wedged, not that Redis is slow.
- **Full box loss.** Provision a new VPS, install Docker + Tailscale, clone the
  repo, restore the latest backup with `restore.sh` into a fresh `trading` db,
  `docker compose --profile apps up -d`. Brackets already at IB continue to
  protect open positions during the outage.
- **Kill switch.** Trip from the dashboard or `POST /killswitch`; it blocks all
  new orders immediately (fails safe to ACTIVE if its own state store is
  unreachable). Re-arm only after confirming the cause is resolved.
