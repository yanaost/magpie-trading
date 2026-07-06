/**
 * `@magpie/strategies` — concrete {@link Strategy} implementations that plug into
 * the pipeline engine. Pure domain code: no I/O, no clock, no framework.
 */
export * from "./qual-sphb/indicators.js";
export * from "./qual-sphb/qual-sphb.strategy.js";
export * from "./earnings-fade/calendar.js";
export * from "./earnings-fade/stall-detector.js";
export * from "./earnings-fade/earnings-fade.strategy.js";
export * from "./hype-momentum/candidates.js";
export * from "./hype-momentum/spike-detector.js";
export * from "./hype-momentum/hype-momentum.strategy.js";
export * from "./friday-monday/trading-week.js";
export * from "./friday-monday/trending-list.js";
export * from "./friday-monday/flow-detector.js";
export * from "./friday-monday/friday-monday.strategy.js";
export * from "./valuation-gravity/watchlist.js";
export * from "./valuation-gravity/journal.js";
export * from "./valuation-gravity/valuation-gravity.strategy.js";
export * from "./snapback/premarket-screener.js";
export * from "./snapback/reclaim-detector.js";
export * from "./snapback/snapback.strategy.js";
export * from "./registry.js";

import type { Strategy } from "@magpie/core";
import { loadStrategies } from "./registry.js";

/**
 * All shipped strategy instances, in registration order. The API layer wires
 * these into the `STRATEGY_INSTANCES` provider and joins them against the
 * `strategies` config rows. Delegates to the plugin registry (T2.3) — the one
 * place strategies are registered.
 */
export function allStrategies(): Strategy[] {
  return loadStrategies();
}
