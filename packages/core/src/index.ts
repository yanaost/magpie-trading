/**
 * @magpie/core — shared domain types and deterministic money-path logic.
 *
 * This package is the single source of truth for domain types (never
 * duplicated elsewhere) and for the sacred money-path modules: the risk
 * manager, order construction, the execution port, and fill models.
 *
 * Money representation: prices, quantities and cash are plain `number`s here so
 * the money path can do arithmetic and round deliberately (see `roundCents`);
 * the repository layer converts the DB's numeric-strings at the boundary. The
 * LLM never sees or sets any of these numbers (spec §4.2). Every payload that
 * crosses a process/db boundary carries a zod schema (T1.1 AC).
 */

// Domain vocabulary and payload/behavioral contracts (spec §3.1).
export * from "./enums.js";
export * from "./market.js";
export * from "./risk.js";
export * from "./signal.js";
export * from "./proposal.js";
export * from "./position.js";
export * from "./execution.js";
export * from "./strategy.js";
export * from "./risk-manager.js";

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
