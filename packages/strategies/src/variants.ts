/**
 * Strategy variants (T3.5) — the same strategy run with different parameters so
 * a tuner can compare them side by side (spec §4.4: "snapback with 30 vs 60
 * minute wait; the tab shows them as comparable rows").
 *
 * A variant is a lightweight *spec* — an instance id, a human label, and a param
 * override bag — not a second registered strategy. Variants are compared through
 * the backtest dimension (one report per variant), which keeps them isolated
 * (each backtest runs its own virtual portfolio) without a variant-aware live
 * registry: the live roster stays one tab per strategy, and variant comparison
 * lives in that tab's backtest view.
 */
import type { Strategy } from "@magpie/core";
import {
  SnapbackStrategy,
  type SnapbackParams,
} from "./snapback/snapback.strategy.js";
import type { PremarketScreener } from "./snapback/premarket-screener.js";

/** External dependencies a variant may need (injected in prod, faked in tests). */
export interface VariantDeps {
  /** Pre-market gapper feed for snapback (defaults to the empty static screener). */
  readonly premarketScreener?: PremarketScreener;
}

/** A parameterised instance of a strategy to backtest and compare. */
export interface StrategyVariantSpec {
  /** Stable id for this variant, e.g. `"snapback:wait30"`. */
  readonly instanceId: string;
  /** The base strategy this varies, e.g. `"snapback"`. */
  readonly strategyId: string;
  /** Human label for the comparison row, e.g. `"30-min wait"`. */
  readonly label: string;
  /** Parameter overrides merged over the strategy's defaults. */
  readonly params: Readonly<Record<string, unknown>>;
}

/** Builds a strategy instance from a variant's param overrides. */
export type VariantBuilder = (
  params: Readonly<Record<string, unknown>>,
  deps: VariantDeps,
) => Strategy;

/**
 * Strategies that accept param overrides for variant comparison. Only the
 * tunable intraday strategies are here; adding one is a single line.
 */
export const VARIANT_BUILDERS: Readonly<Record<string, VariantBuilder>> = {
  snapback: (params, deps) =>
    new SnapbackStrategy(
      deps.premarketScreener,
      params as Partial<SnapbackParams>,
    ),
};

/** Whether a strategy supports variant param overrides. */
export function supportsVariants(strategyId: string): boolean {
  return strategyId in VARIANT_BUILDERS;
}

/**
 * Construct the strategy instance a variant spec describes.
 * @throws if the strategy has no registered variant builder.
 */
export function buildVariantStrategy(
  spec: StrategyVariantSpec,
  deps: VariantDeps = {},
): Strategy {
  const build = VARIANT_BUILDERS[spec.strategyId];
  if (!build) {
    throw new Error(`no variant builder for strategy: ${spec.strategyId}`);
  }
  return build(spec.params, deps);
}

/**
 * Snapback wait-time variants — the canonical §4.4 comparison. One spec per
 * `waitMinutes` value (e.g. `[30, 60]` → the AC's two variants).
 */
export function snapbackWaitVariants(
  waitMinutes: readonly number[],
): StrategyVariantSpec[] {
  return waitMinutes.map((wait) => ({
    instanceId: `snapback:wait${wait}`,
    strategyId: "snapback",
    label: `${wait}-min wait`,
    params: { waitMinutes: wait },
  }));
}

/** The default wait-time comparison shipped for snapback (spec: 30 vs 60). */
export const DEFAULT_SNAPBACK_VARIANTS: readonly StrategyVariantSpec[] =
  snapbackWaitVariants([30, 60]);
