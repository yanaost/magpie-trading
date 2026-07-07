import type { ReactNode } from "react";
import { modeTone, targetTone } from "@/lib/chip-tone";

/**
 * The shared state chip (spec §U3): a small colour-coded pill reused in the tab
 * strip, on proposal cards, and in the global header summary. Colour is driven
 * by {@link modeTone}/{@link targetTone} so seriousness reads consistently
 * everywhere (grey = idle, amber = gated/paper, red = hands-off/live).
 */
function Chip({
  label,
  tone,
  title,
}: {
  label: string;
  tone: "idle" | "amber" | "danger";
  title?: string;
}): ReactNode {
  return (
    <span className={`chip chip-${tone}`} title={title}>
      {label}
    </span>
  );
}

/** Operating-mode chip (AUTO / APPROVE / WATCH / OFF). */
export function ModeChip({ mode }: { mode: string }): ReactNode {
  return (
    <Chip
      label={mode.toUpperCase()}
      tone={modeTone(mode)}
      title={`Mode: ${mode.toUpperCase()}`}
    />
  );
}

/** Execution-target chip (SIM / PAPER / LIVE). */
export function TargetChip({ target }: { target: string }): ReactNode {
  return (
    <Chip
      label={target.toUpperCase()}
      tone={targetTone(target)}
      title={`Target: ${target.toUpperCase()}`}
    />
  );
}
