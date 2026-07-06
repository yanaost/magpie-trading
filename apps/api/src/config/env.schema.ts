import { z } from "zod";

/**
 * Environment schema. Validated once at boot; a malformed env aborts startup
 * with a readable error rather than failing deep in a request. Secrets are
 * optional here so the skeleton boots in dev before they are filled in, but
 * services that need them assert their presence when used.
 */
export const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  PORT: z.coerce.number().int().positive().default(3001),

  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),

  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().default("claude-sonnet-5"),

  IB_GATEWAY_HOST: z.string().default("localhost"),
  IB_GATEWAY_PORT: z.coerce.number().int().positive().default(4002),
  IB_ACCOUNT_ID: z.string().optional(),
  /** TWS/Gateway API client id; unique per concurrent connection. */
  IB_CLIENT_ID: z.coerce.number().int().nonnegative().default(10),

  /** Whether to open a live IB connection + realtime subscriptions at boot. */
  MARKET_DATA_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  /** Comma-separated tickers to stream/backfill. */
  MARKET_DATA_TICKERS: z.string().default("QUAL,SPHB,SPY"),
  /** Minimum spacing between IB historical requests (pacing guard), ms. */
  IB_PACING_INTERVAL_MS: z.coerce.number().int().positive().default(10_000),
  /** Reconnect backoff bounds, ms. */
  IB_RECONNECT_BASE_MS: z.coerce.number().int().positive().default(1_000),
  IB_RECONNECT_MAX_MS: z.coerce.number().int().positive().default(30_000),

  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_CHAT_ID: z.string().optional(),

  APP_AUTH_SECRET: z.string().min(1).optional(),
  KILL_SWITCH_DAILY_LOSS_PCT: z.coerce.number().positive().default(3),

  /** Heartbeat interval for the Phase 0 demo job (ms). Default 30s per T0.4. */
  DEMO_JOB_INTERVAL_MS: z.coerce.number().int().positive().default(30_000),

  /** Interval for pushing /healthz to dashboards over WS (ms). Default 5s. */
  HEALTH_BROADCAST_MS: z.coerce.number().int().positive().default(5_000),

  /** Signal-pipeline scan cadence (ms). Default 60s (intraday strategies poll faster). */
  PIPELINE_SCAN_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),
  /** Position-monitor cadence (ms). Default 30s — exits must react promptly. */
  PIPELINE_MONITOR_INTERVAL_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(30_000),
  /** Proposal TTL-expiry sweep cadence (ms). Default 60s. */
  PIPELINE_EXPIRY_SWEEP_MS: z.coerce.number().int().positive().default(60_000),
  /**
   * Crowding-filter refresh cadence (ms) — the nightly job that asks the LLM
   * for currently over-recommended tickers (strategy #6, T2.4 / BRINGUP B1).
   * Default 24h. Failures (e.g. no ANTHROPIC_API_KEY / no credits) are isolated
   * so a bad run never crashes the worker.
   */
  PIPELINE_CROWDING_REFRESH_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(86_400_000),

  /**
   * Uptime monitor (T3.6). When enabled, a background loop probes gateway
   * reachability, worker liveness, and queue backlog, and pushes a Telegram
   * alert on the *transition* into (and out of) an unhealthy state.
   */
  UPTIME_MONITOR_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  /** Uptime probe cadence (ms). Default 60s. */
  UPTIME_CHECK_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),
  /** Queue backlog alert threshold: waiting+delayed jobs above this fire. */
  UPTIME_QUEUE_BACKLOG_MAX: z.coerce.number().int().positive().default(100),
  /**
   * Worker-stalled threshold (ms). If no worker heartbeat has landed within this
   * window, the worker is considered stalled. Default 3× the demo heartbeat.
   */
  UPTIME_WORKER_STALE_MS: z.coerce.number().int().positive().default(90_000),

  /**
   * Replay engine (T3.1). When enabled, the API binds the deterministic replay
   * clock/analyst/context provider instead of the live ones, so a backtest runs
   * the same money path against historical candles.
   */
  REPLAY_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  /** Playback speed vs real time (1 = real, 60 = 60×). */
  REPLAY_SPEED_MULTIPLIER: z.coerce.number().min(1).max(60).default(60),
  /**
   * Fraction of cache-missed signals the analyst stub passes, in [0, 1]. The
   * per-signal draw is deterministic (seeded by the signal's context hash), so
   * this sets *which* signals pass, not a random rate.
   */
  REPLAY_STUB_PASS_RATE: z.coerce.number().min(0).max(1).default(0.7),

  /**
   * Enables the dev-only synthetic-signal trigger endpoint (`POST /dev/...`),
   * used for the T1.9 full-loop demo. Unset means "enabled outside production"
   * (resolved against NODE_ENV in the controller); set `"true"`/`"false"` to
   * force it on/off explicitly.
   */
  DEV_TRIGGER_ENABLED: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === "true")),
});

export type AppConfig = z.infer<typeof envSchema>;

/** DI token for the validated, frozen config object. */
export const APP_CONFIG = Symbol("APP_CONFIG");

/**
 * Parse and validate `process.env`. Throws a formatted error listing every
 * invalid/missing variable.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return Object.freeze(result.data);
}
