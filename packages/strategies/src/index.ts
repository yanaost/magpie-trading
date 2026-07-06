/**
 * `@magpie/strategies` — concrete {@link Strategy} implementations that plug into
 * the pipeline engine. Pure domain code: no I/O, no clock, no framework.
 */
export * from "./qual-sphb/indicators.js";
export * from "./qual-sphb/qual-sphb.strategy.js";
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
