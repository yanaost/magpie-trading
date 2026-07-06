/**
 * Promotion gate (T2.2). A strategy climbs the execution ladder
 * SIM → PAPER → LIVE one rung at a time, and each upward step must be *earned*:
 * a minimum number of closed trades at the current rung plus an attached human
 * review note. Demotions are always allowed (you can always pull risk down),
 * and same-rung changes (mode-only) bypass the gate entirely.
 *
 * This module is pure — it takes the facts (from/to rung, closed-trade count,
 * note) and returns a decision. The service supplies the trade count from the
 * DB and turns a rejection into an audited 422; the ladder policy itself lives
 * here so the math is unit-testable in isolation (AC: "unit tests for gate
 * math").
 */

/** Minimum closed trades at the current rung before promotion is allowed. */
export const PROMOTION_MIN_CLOSED_TRADES = 30;

/** Ordered execution rungs; a higher index is a higher-risk rung. */
const RUNG: Readonly<Record<string, number>> = { SIM: 0, PAPER: 1, LIVE: 2 };

/** Which way a target change moves along the ladder. */
export type PromotionDirection = "promotion" | "demotion" | "none";

/** Why a promotion was refused (stable codes for the API + audit log). */
export type GateRejectionCode =
  "LIVE_LOCKED" | "NOTE_REQUIRED" | "INSUFFICIENT_TRADES";

/** Inputs to the gate decision. */
export interface GateInput {
  /** Current execution target (the rung being promoted *from*). */
  readonly from: string;
  /** Requested execution target (the rung being promoted *to*). */
  readonly to: string;
  /** Closed trades the strategy has completed at the `from` rung. */
  readonly closedTrades: number;
  /** Human review note attached to the change, if any. */
  readonly note?: string;
  /** Override the default trade threshold (tests / config). */
  readonly minTrades?: number;
}

/** The gate's verdict. */
export interface GateDecision {
  readonly allowed: boolean;
  readonly direction: PromotionDirection;
  readonly code?: GateRejectionCode;
  readonly reason?: string;
  /** Threshold that applied, when the rejection was trade-count based. */
  readonly required?: number;
}

/** Classify a target change as a promotion, demotion, or no-op. */
export function classifyTargetChange(
  from: string,
  to: string,
): PromotionDirection {
  const a = RUNG[from];
  const b = RUNG[to];
  if (a === undefined || b === undefined) {
    throw new Error(`unknown execution target in change ${from} → ${to}`);
  }
  if (b > a) return "promotion";
  if (b < a) return "demotion";
  return "none";
}

/**
 * Decide whether a target change is permitted.
 * @returns an `allowed: true` decision for no-ops and demotions; for promotions,
 * enforces the LIVE lock (rule 6), a non-empty review note, and the closed-trade
 * threshold, in that order.
 */
export function evaluatePromotionGate(input: GateInput): GateDecision {
  const direction = classifyTargetChange(input.from, input.to);
  if (direction !== "promotion") {
    return { allowed: true, direction };
  }

  // Rule 6: LIVE is locked in code — never promotable via config.
  if (input.to === "LIVE") {
    return {
      allowed: false,
      direction,
      code: "LIVE_LOCKED",
      reason:
        "LIVE trading is locked (rule 6); strategies cannot be promoted to LIVE.",
    };
  }

  if (!input.note || input.note.trim().length === 0) {
    return {
      allowed: false,
      direction,
      code: "NOTE_REQUIRED",
      reason: `Promotion ${input.from} → ${input.to} requires an attached review note.`,
    };
  }

  const required = input.minTrades ?? PROMOTION_MIN_CLOSED_TRADES;
  if (input.closedTrades < required) {
    return {
      allowed: false,
      direction,
      code: "INSUFFICIENT_TRADES",
      required,
      reason: `Promotion ${input.from} → ${input.to} needs ≥${required} closed trades at ${input.from}; only ${input.closedTrades} so far.`,
    };
  }

  return { allowed: true, direction };
}

/** Thrown by the service when the gate refuses a promotion. */
export class PromotionGateError extends Error {
  constructor(
    readonly code: GateRejectionCode,
    reason: string,
  ) {
    super(reason);
    this.name = "PromotionGateError";
  }
}
