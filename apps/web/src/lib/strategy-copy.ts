/**
 * Plain-language mode/target copy shown in the selectors' info popovers and
 * captions (spec §U4). Copied verbatim from the spec — do not paraphrase; these
 * are the definitions the whole UI is allowed to assume the operator knows.
 */
export const MODE_DESCRIPTIONS: Record<string, string> = {
  AUTO: "Trades by itself when a signal passes all checks. You're notified after.",
  APPROVE:
    "Builds the full trade and asks you first. Unanswered proposals expire.",
  WATCH:
    "Finds and journals signals but never trades. For observing and incubating.",
  OFF: "Loaded but idle. No scanning, no signals.",
};

export const TARGET_DESCRIPTIONS: Record<string, string> = {
  SIM: "Practice mode — Magpie's built-in simulator, virtual money, instant resets.",
  PAPER:
    "Real orders to Interactive Brokers' practice account. Fake money, real plumbing.",
  LIVE: "Real money. Locked until a strategy earns promotion.",
};

/** Ordered option lists for the popovers (most → least hands-off). */
export const MODE_OPTIONS = ["AUTO", "APPROVE", "WATCH", "OFF"] as const;
export const TARGET_OPTIONS = ["SIM", "PAPER", "LIVE"] as const;

/**
 * Human-readable TTL for the APPROVE caption, rendered from the config value in
 * ms (spec §U4: "the strategy's actual proposal expiry (from config)"). Whole
 * minutes when it divides evenly, else seconds — so 900000 → "15 min".
 */
export function formatTtl(ms: number): string {
  if (ms % 60_000 === 0) {
    const min = ms / 60_000;
    return `${min} min`;
  }
  return `${Math.round(ms / 1000)} sec`;
}

/**
 * The caption under the mode selector for the currently selected mode. The
 * APPROVE line additionally names the real proposal expiry from config.
 */
export function modeCaption(mode: string, proposalTtlMs: number): string {
  const base = MODE_DESCRIPTIONS[mode.toUpperCase()] ?? "";
  if (mode.toUpperCase() === "APPROVE") {
    return `${base} Proposals expire after ${formatTtl(proposalTtlMs)}.`;
  }
  return base;
}

/** The caption under the target selector for the currently selected target. */
export function targetCaption(target: string): string {
  return TARGET_DESCRIPTIONS[target.toUpperCase()] ?? "";
}

/**
 * Whether a mode change needs the explicit confirmation gate before it may be
 * applied (spec §U4): switching *to* AUTO does, everything else does not. The
 * component must not apply an AUTO change unless the user has confirmed — this
 * pure guard makes that rule unit-testable.
 */
export function needsAutoConfirmation(nextMode: string): boolean {
  return nextMode.toUpperCase() === "AUTO";
}
