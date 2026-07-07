"use client";

import type { ReactNode } from "react";
import type { StrategySummary } from "@/lib/api";
import { useLiveStrategies } from "./use-live-strategies";

/**
 * Global header summary (spec §U3): a compact, always-visible count of the
 * riskiest live states — how many strategies are hands-off (AUTO) and how many
 * point at a real broker (target ≥ PAPER) — so those never hide behind an
 * unopened tab. Renders nothing when everything is idle (nothing at stake).
 * Shares the live roster with the tab strip via {@link useLiveStrategies}, so a
 * mode change or kill-switch trip updates it live.
 */
export default function StrategyStatusSummary({
  initial,
}: {
  initial: StrategySummary[];
}): ReactNode {
  const { strategies } = useLiveStrategies(initial);

  const auto = strategies.filter((s) => s.mode.toUpperCase() === "AUTO").length;
  const paper = strategies.filter(
    (s) => s.target.toUpperCase() === "PAPER",
  ).length;
  const live = strategies.filter(
    (s) => s.target.toUpperCase() === "LIVE",
  ).length;

  if (auto === 0 && paper === 0 && live === 0) return null;

  const parts: string[] = [];
  if (auto > 0) parts.push(`${auto} AUTO`);
  if (paper > 0) parts.push(`${paper} PAPER`);
  if (live > 0) parts.push(`${live} LIVE`);

  // Red when anything is truly hands-off/real-money, amber for paper-only.
  const tone = auto > 0 || live > 0 ? "chip-danger" : "chip-amber";

  return (
    <span
      className={`chip ${tone}`}
      title="Strategies in a hands-off or broker-connected state"
    >
      {parts.join(" · ")}
    </span>
  );
}
