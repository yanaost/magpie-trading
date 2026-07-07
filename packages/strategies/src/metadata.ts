/**
 * Strategy metadata registry (spec §U2). Every executable strategy carries its
 * own {@link StrategyMeta} on the plugin instance (required by the `Strategy`
 * interface, so a missing one fails typecheck). The AI-crowding filter is *not*
 * an order-emitting `Strategy` — it lives in the API layer — so its metadata is
 * declared here as a literal and merged in, giving the dashboard one map keyed
 * by strategy id that covers all eight roster entries.
 */
import type { StrategyMeta } from "@magpie/core";
import { loadStrategies } from "./registry.js";

/** Roster id of the AI-crowding filter (a filter, not a `Strategy` plugin). */
export const AI_CROWDING_FILTER_ID = "ai-crowding-filter";

/**
 * Metadata for the AI-crowding filter. Considered `dataReady` because its feed —
 * Claude's web-research scan of crowded longs — is a live, implemented provider
 * whenever an Anthropic key is configured (it falls back to an inert null
 * researcher only when the key is absent).
 */
export const AI_CROWDING_FILTER_META: StrategyMeta = {
  summary:
    "Not a trading strategy but a portfolio-wide safety filter. Each night Claude " +
    "researches which stocks the crowd is piling into, and the filter blocks or " +
    "warns on new trades in those over-loved names so the book does not stack up " +
    "in the same crowded corner.",
  mechanic: {
    trigger: [
      "A nightly scan asks Claude which names are the most crowded long positions right now",
      "Those tickers are held on a watchlist with an expiry",
      "New proposals in a crowded name are vetoed or flagged",
    ],
    exitPlan: [
      "Not applicable — the filter holds no positions; its entries expire on a timer and refresh nightly",
    ],
    llmRole:
      "Claude identifies the currently most-crowded long trades, with evidence, so the system can avoid adding to them.",
    dataNeeds: "Claude web-research crowding scan",
  },
  dataReady: true,
};

/**
 * Build the id→metadata map for all eight roster strategies: the seven
 * executable plugins (from their own `.meta`) plus the AI-crowding filter.
 */
export function buildStrategyMetaById(): Record<string, StrategyMeta> {
  const map: Record<string, StrategyMeta> = {};
  for (const strategy of loadStrategies()) {
    map[strategy.id] = strategy.meta;
  }
  map[AI_CROWDING_FILTER_ID] = AI_CROWDING_FILTER_META;
  return map;
}
