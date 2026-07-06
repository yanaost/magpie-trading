/**
 * Strategy plugin registry (T2.3). The single place a strategy is *registered*
 * with the running system: each strategy folder exports a zero-arg factory, and
 * adding one line here makes the strategy a first-class citizen everywhere
 * downstream — the pipeline runs it, and the dashboard grows a tab for it — with
 * no other code changes (AC: "adding a strategy makes a functioning tab appear
 * with zero UI code changes"). The tab is data-driven off the strategy roster
 * the API returns, so the UI never names strategies.
 *
 * A factory (not a shared singleton) so each caller gets an isolated instance;
 * strategies hold no cross-instance state, but this keeps that guarantee cheap.
 */
import type { Strategy } from "@magpie/core";
import { QualSphbStrategy } from "./qual-sphb/qual-sphb.strategy.js";

/** Constructs a fresh strategy instance. */
export type StrategyFactory = () => Strategy;

/**
 * Every registered strategy factory, in registration order. To add a strategy:
 * drop its folder under `src/<id>/`, export a factory, and add one line here.
 */
export const STRATEGY_FACTORIES: readonly StrategyFactory[] = [
  () => new QualSphbStrategy(),
];

/** Instantiate all registered strategies. */
export function loadStrategies(
  factories: readonly StrategyFactory[] = STRATEGY_FACTORIES,
): Strategy[] {
  const instances = factories.map((make) => make());
  const seen = new Set<string>();
  for (const s of instances) {
    if (seen.has(s.id)) {
      throw new Error(`duplicate strategy id in registry: ${s.id}`);
    }
    seen.add(s.id);
  }
  return instances;
}
