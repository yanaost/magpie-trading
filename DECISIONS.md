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
