/**
 * Risk parameters (spec §5). The global limits are hard ceilings the risk
 * manager enforces in deterministic code; per-strategy `RiskParams` may only
 * *tighten* them, never exceed them (T1.2 enforces this). These types are
 * persisted in `strategies.risk_overrides` (jsonb), so they cross the db
 * boundary and carry a zod schema.
 */
import { z } from "zod";

/** Percentage in the 0–100 domain (e.g. `2` means 2%). */
const PercentSchema = z.number().finite().positive();

/**
 * Per-strategy risk configuration. Every field is a tightening override of the
 * corresponding {@link GLOBAL_RISK_LIMITS} ceiling; the risk manager rejects a
 * value that would loosen a global cap.
 */
export const RiskParamsSchema = z.object({
  /** Max capital risked per trade (stop distance × size) as % of equity. 1–2. */
  maxRiskPerTradePct: PercentSchema,
  /** Max concurrent open positions across all strategies. */
  maxConcurrentPositions: z.number().int().positive(),
  /** Max concurrent open positions for this one strategy. */
  maxPositionsPerStrategy: z.number().int().positive(),
  /** Max concurrent open positions in a single ticker across strategies. */
  maxPositionsPerTicker: z.number().int().positive(),
  /** Max total open risk (sum of per-position risk) as % of equity. */
  maxTotalOpenRiskPct: PercentSchema,
  /** Daily loss (% of equity) that trips the kill switch automatically. */
  dailyLossLimitPct: PercentSchema,
  /** Whether a stop-loss is mandatory on every proposal (always true for MVP). */
  requireStop: z.boolean(),
  /** Whether adding to a losing position is allowed (always false — spec §5). */
  allowAveragingDown: z.boolean(),
  /** Intraday strategies must be flat by close (no overnight holds). */
  noOvernightHolds: z.boolean().default(false),
  /** Options must be defined-risk only (long/debit); no naked shorts. */
  definedRiskOptionsOnly: z.boolean().default(true),
});
/** Per-strategy risk overrides (a tightening of the global ceilings). */
export type RiskParams = z.infer<typeof RiskParamsSchema>;

/**
 * The hard global risk ceilings from spec §5. These are the maximums the risk
 * manager will ever permit; `RiskParams` may tighten but not exceed them.
 * Encoded as a frozen constant so nothing can mutate the limits at runtime.
 */
export const GLOBAL_RISK_LIMITS = Object.freeze({
  /** Absolute cap on per-trade risk (%). Config may go lower, never higher. */
  maxRiskPerTradePct: 2,
  /** Absolute cap on concurrent positions across all strategies. */
  maxConcurrentPositions: 5,
  /** Absolute cap on concurrent positions per strategy. */
  maxPositionsPerStrategy: 2,
  /** Absolute cap on concurrent positions per ticker. */
  maxPositionsPerTicker: 1,
  /** Absolute cap on total open risk (%). */
  maxTotalOpenRiskPct: 6,
  /** Daily loss (%) that force-trips the kill switch. */
  dailyLossLimitPct: 3,
} as const);

/**
 * Sensible default `RiskParams` — the loosest configuration still within the
 * global ceilings. Strategies start here and tighten as needed.
 */
export const DEFAULT_RISK_PARAMS: RiskParams = Object.freeze({
  maxRiskPerTradePct: 1,
  maxConcurrentPositions: GLOBAL_RISK_LIMITS.maxConcurrentPositions,
  maxPositionsPerStrategy: GLOBAL_RISK_LIMITS.maxPositionsPerStrategy,
  maxPositionsPerTicker: GLOBAL_RISK_LIMITS.maxPositionsPerTicker,
  maxTotalOpenRiskPct: GLOBAL_RISK_LIMITS.maxTotalOpenRiskPct,
  dailyLossLimitPct: GLOBAL_RISK_LIMITS.dailyLossLimitPct,
  requireStop: true,
  allowAveragingDown: false,
  noOvernightHolds: false,
  definedRiskOptionsOnly: true,
});
