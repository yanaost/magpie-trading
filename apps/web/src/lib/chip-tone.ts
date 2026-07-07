/**
 * Seriousness colour-coding for mode/target chips (spec §U3), shared by the tab
 * strip, proposal cards, and the global header summary so the same state always
 * reads the same colour across the app.
 *
 * Three tones, ordered by how much money is at stake:
 *   - `idle`   — nothing can trade (mode OFF/WATCH, target SIM): neutral grey.
 *   - `amber`  — a human gate or the paper broker (mode APPROVE, target PAPER).
 *   - `danger` — hands-off or real money (mode AUTO, target LIVE): red.
 *
 * Pure string→token functions with no React/DOM dependency so the mapping is
 * unit-testable on its own (spec §U3 AC: "component tests for chip colour
 * mapping").
 */
export type ChipTone = "idle" | "amber" | "danger";

/** Colour tone for an operating mode. Unknown values fall back to `idle`. */
export function modeTone(mode: string): ChipTone {
  switch (mode.toUpperCase()) {
    case "AUTO":
      return "danger";
    case "APPROVE":
      return "amber";
    case "WATCH":
    case "OFF":
    default:
      return "idle";
  }
}

/** Colour tone for an execution target. Unknown values fall back to `idle`. */
export function targetTone(target: string): ChipTone {
  switch (target.toUpperCase()) {
    case "LIVE":
      return "danger";
    case "PAPER":
      return "amber";
    case "SIM":
    default:
      return "idle";
  }
}
