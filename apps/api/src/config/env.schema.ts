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
