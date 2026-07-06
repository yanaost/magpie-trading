/**
 * The canonical strategy roster (spec §3.2). Kept separate from the seed
 * script so it can be imported by tests without triggering a DB connection.
 */
import { strategies } from "./schema.js";

type Timeframe = (typeof strategies.timeframe.enumValues)[number];

export interface SeedStrategy {
  id: string;
  name: string;
  timeframe: Timeframe;
  /** Recommended live mode from spec §3.2 (informational; seeded as WATCH). */
  recommendedMode: "AUTO" | "APPROVE" | "WATCH";
}

export const ROSTER: readonly SeedStrategy[] = [
  {
    id: "earnings-fade",
    name: "Earnings fade",
    timeframe: "swing",
    // Long-only default is a do-not-buy filter (T2.5) — WATCH-first.
    recommendedMode: "WATCH",
  },
  {
    id: "hype-momentum",
    name: "Hype momentum",
    timeframe: "swing",
    recommendedMode: "APPROVE",
  },
  {
    id: "qual-sphb",
    name: "QUAL/SPHB pair",
    timeframe: "weekly",
    recommendedMode: "APPROVE",
  },
  {
    id: "squeeze-scalp",
    name: "Squeeze scalp",
    timeframe: "intraday",
    recommendedMode: "AUTO",
  },
  {
    id: "snapback",
    name: "Snapback",
    timeframe: "intraday",
    recommendedMode: "AUTO",
  },
  {
    id: "ai-crowding-filter",
    name: "AI-crowding filter",
    timeframe: "filter",
    recommendedMode: "WATCH",
  },
  {
    id: "friday-monday-flow",
    name: "Friday→Monday flow",
    timeframe: "weekly",
    recommendedMode: "APPROVE",
  },
  {
    id: "valuation-gravity",
    name: "Valuation gravity watchlist",
    timeframe: "observation",
    recommendedMode: "WATCH",
  },
];

/** Build the DB rows for the roster — all seeded WATCH mode / SIM target. */
export function buildSeedRows() {
  return ROSTER.map((s) => ({
    id: s.id,
    name: s.name,
    timeframe: s.timeframe,
    mode: "WATCH" as const,
    target: "SIM" as const,
    config: { recommendedMode: s.recommendedMode },
    riskOverrides: {},
  }));
}
