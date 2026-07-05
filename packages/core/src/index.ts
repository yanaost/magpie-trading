/**
 * @trading-app/core — shared domain types and deterministic money-path logic.
 *
 * This package is the single source of truth for domain types (never
 * duplicated elsewhere) and for the sacred money-path modules: the risk
 * manager, order construction, the execution port, and fill models.
 *
 * The full domain surface is implemented across Phase 1 (see TASKS.md T1.x).
 * This entry point is intentionally small during Phase 0.
 */

/** Semantic version of the core domain contract. */
export const CORE_VERSION = "0.1.0" as const;

/**
 * Convert a basis-points value to a decimal fraction.
 * 1 bp = 0.01% = 0.0001. Used by the slippage / fill models.
 *
 * @param bps - basis points (e.g. `5` for 5 bps)
 * @returns the fraction (e.g. `0.0005`)
 */
export function bpsToFraction(bps: number): number {
  return bps / 10_000;
}

/**
 * Round a monetary amount to whole cents to avoid float drift in the
 * money path. Uses banker-safe rounding at cent granularity.
 *
 * @param amount - amount in currency units (dollars)
 * @returns the amount rounded to 2 decimal places
 */
export function roundCents(amount: number): number {
  return Math.round((amount + Number.EPSILON) * 100) / 100;
}
