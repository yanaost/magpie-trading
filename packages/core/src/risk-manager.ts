/**
 * The RiskManager (spec §5, T1.2) — the deterministic gate between a strategy's
 * {@link ProposalDraft} and a finalized {@link TradeProposal}. It owns position
 * sizing and enforces the hard global limits in plain code (never the LLM). Its
 * rules are hard-coded; per-strategy {@link RiskParams} may only *tighten* them,
 * so the manager clamps every effective limit to `min(config, global)`.
 *
 * It is pure: it reads a snapshot ({@link RiskContext}) and returns a
 * {@link RiskDecision}. It never touches the DB — the caller persists the
 * emitted {@link RiskEvent} to `risk_events` and the approved proposal.
 */
import { z } from "zod";
import { roundCents } from "./index.js";
import { SeveritySchema, type Severity } from "./enums.js";
import type { Position } from "./position.js";
import type { ProposalDraft } from "./proposal.js";
import { TradeProposalSchema, type TradeProposal } from "./proposal.js";
import {
  GLOBAL_RISK_LIMITS,
  RiskParamsSchema,
  type RiskParams,
} from "./risk.js";

/** Default proposal time-to-live (spec §2): 15 minutes. */
export const DEFAULT_PROPOSAL_TTL_MS = 15 * 60 * 1000;

/**
 * The closed set of rule codes the risk layer can reject (or trip) on. Persisted
 * verbatim to `risk_events.rule`, so treat these strings as a stable contract.
 */
export const RISK_RULES = [
  "kill_switch_active",
  "invalid_stop",
  "no_averaging_down",
  "max_positions_total",
  "max_positions_per_strategy",
  "max_positions_per_ticker",
  "per_trade_risk",
  "total_open_risk",
  "daily_loss_limit",
] as const;
/** Zod schema for {@link RiskRule}. */
export const RiskRuleSchema = z.enum(RISK_RULES);
/** A rule code recorded on a `risk_events` row. */
export type RiskRule = z.infer<typeof RiskRuleSchema>;

/**
 * A risk event as persisted to `risk_events` (spec §7). Emitted on every
 * rejection and on a kill-switch trip; crosses the db boundary so it is
 * schema-validated.
 */
export const RiskEventSchema = z.object({
  /** Strategy the event concerns, when applicable. */
  strategyId: z.string().min(1).optional(),
  /** Proposal the event concerns, when applicable. */
  proposalId: z.string().uuid().optional(),
  /** Which rule fired. */
  rule: RiskRuleSchema,
  /** Human-readable reason (surfaced in the strategy tab's signal log). */
  reason: z.string().min(1),
  /** Structured context for the log (numbers behind the decision). */
  context: z.record(z.unknown()).default({}),
  /** How serious the event is. */
  severity: SeveritySchema.default("warning"),
});
/** A risk event row destined for `risk_events`. */
export type RiskEvent = z.infer<typeof RiskEventSchema>;

/**
 * A read-only snapshot the RiskManager evaluates a draft against. The caller
 * assembles it from live account/positions state; the manager does no I/O.
 */
export interface RiskContext {
  /** Logical "now" (drives proposal expiry). */
  readonly now: Date;
  /** Account equity in USD, used for all percentage limits and sizing. */
  readonly equity: number;
  /** Rung the resulting proposal will execute against. */
  readonly executionTarget: TradeProposal["executionTarget"];
  /** All currently open positions across every strategy. */
  readonly openPositions: readonly Position[];
  /** Whether the global kill switch is currently tripped. */
  readonly killSwitchActive?: boolean;
  /** Proposal TTL override (defaults to {@link DEFAULT_PROPOSAL_TTL_MS}). */
  readonly proposalTtlMs?: number;
}

/**
 * The outcome of evaluating a draft: either an approved, fully-sized proposal or
 * a rejection carrying the exact rule/reason to persist.
 */
export type RiskDecision =
  | { readonly approved: true; readonly proposal: TradeProposal }
  | { readonly approved: false; readonly event: RiskEvent };

/** Result of a daily-loss check. */
export interface DailyLossResult {
  /** Whether the −Nx% daily loss limit was breached. */
  readonly tripped: boolean;
  /** The critical kill-switch event to persist, present only when tripped. */
  readonly event?: RiskEvent;
}

/** Round a percentage to 4 dp (matches `risk_pct` numeric(8,4) at the db edge). */
function roundPct(pct: number): number {
  return Math.round((pct + Number.EPSILON) * 1e4) / 1e4;
}

/**
 * Deterministic risk gate and position sizer (spec §5). Construct once per
 * strategy with its {@link RiskParams}; the effective limits are clamped so
 * config can tighten but never exceed the {@link GLOBAL_RISK_LIMITS}.
 */
export class RiskManager {
  /** The clamped, effective limits actually enforced (never exceed globals). */
  readonly limits: {
    readonly maxRiskPerTradePct: number;
    readonly maxConcurrentPositions: number;
    readonly maxPositionsPerStrategy: number;
    readonly maxPositionsPerTicker: number;
    readonly maxTotalOpenRiskPct: number;
    readonly dailyLossLimitPct: number;
    readonly requireStop: boolean;
    readonly allowAveragingDown: boolean;
  };

  /**
   * @param params - per-strategy risk overrides (validated and clamped)
   */
  constructor(params: RiskParams) {
    RiskParamsSchema.parse(params);
    // "config can tighten but not exceed" — clamp every ceiling to the global.
    this.limits = {
      maxRiskPerTradePct: Math.min(
        params.maxRiskPerTradePct,
        GLOBAL_RISK_LIMITS.maxRiskPerTradePct,
      ),
      maxConcurrentPositions: Math.min(
        params.maxConcurrentPositions,
        GLOBAL_RISK_LIMITS.maxConcurrentPositions,
      ),
      maxPositionsPerStrategy: Math.min(
        params.maxPositionsPerStrategy,
        GLOBAL_RISK_LIMITS.maxPositionsPerStrategy,
      ),
      maxPositionsPerTicker: Math.min(
        params.maxPositionsPerTicker,
        GLOBAL_RISK_LIMITS.maxPositionsPerTicker,
      ),
      maxTotalOpenRiskPct: Math.min(
        params.maxTotalOpenRiskPct,
        GLOBAL_RISK_LIMITS.maxTotalOpenRiskPct,
      ),
      dailyLossLimitPct: Math.min(
        params.dailyLossLimitPct,
        GLOBAL_RISK_LIMITS.dailyLossLimitPct,
      ),
      requireStop: params.requireStop,
      allowAveragingDown: params.allowAveragingDown,
    };
  }

  /**
   * The open dollar risk of a position: `qty × |entry − stop|`. A position with
   * no working stop contributes 0 (positions must carry a stop, so this is a
   * defensive floor, not the normal path).
   * @param p - the open position
   */
  private static positionRisk(p: Position): number {
    if (p.stopPrice === undefined) return 0;
    return p.qty * Math.abs(p.avgEntryPrice - p.stopPrice);
  }

  private reject(
    rule: RiskRule,
    reason: string,
    draft: ProposalDraft,
    context: Record<string, unknown>,
    severity: Severity = "warning",
  ): RiskDecision {
    return {
      approved: false,
      event: RiskEventSchema.parse({
        strategyId: draft.strategyId,
        rule,
        reason,
        severity,
        context,
      }),
    };
  }

  /**
   * Evaluate a draft: run every hard rule in order, size the position, and
   * return an approved {@link TradeProposal} or the first rejection.
   *
   * Rule order (cheap structural checks first, sizing last):
   * kill switch → stop validity → no averaging down → position count caps →
   * per-trade sizing → total open risk.
   *
   * @param draft - the strategy's pre-sizing trade idea
   * @param ctx - the account/positions snapshot to evaluate against
   */
  evaluate(draft: ProposalDraft, ctx: RiskContext): RiskDecision {
    const open = ctx.openPositions.filter((p) => p.status === "open");

    // 0. Global kill switch — nothing new gets through while tripped.
    if (ctx.killSwitchActive) {
      return this.reject(
        "kill_switch_active",
        "Kill switch is active — all new orders are blocked.",
        draft,
        {},
        "critical",
      );
    }

    // 1. Mandatory, correctly-placed stop (exit before entry).
    if (this.limits.requireStop && !Number.isFinite(draft.stop)) {
      return this.reject(
        "invalid_stop",
        "A stop-loss is mandatory on every proposal.",
        draft,
        {},
      );
    }
    const stopBelowEntry = draft.stop < draft.entry;
    const stopValidForSide =
      draft.side === "long" ? stopBelowEntry : !stopBelowEntry;
    if (!stopValidForSide) {
      return this.reject(
        "invalid_stop",
        `Stop ${draft.stop} is on the wrong side of entry ${draft.entry} for a ${draft.side} position.`,
        draft,
        { entry: draft.entry, stop: draft.stop, side: draft.side },
      );
    }

    // 2. No averaging down — never add to an existing position in the same
    //    ticker+side for this strategy.
    if (!this.limits.allowAveragingDown) {
      const sameLeg = open.filter(
        (p) =>
          p.strategyId === draft.strategyId &&
          p.ticker === draft.ticker &&
          p.side === draft.side,
      );
      if (sameLeg.length > 0) {
        return this.reject(
          "no_averaging_down",
          `Already holding a ${draft.side} ${draft.ticker} position for ${draft.strategyId}; averaging down is not allowed.`,
          draft,
          { existing: sameLeg.length },
        );
      }
    }

    // 3. Concurrent-position caps.
    if (open.length >= this.limits.maxConcurrentPositions) {
      return this.reject(
        "max_positions_total",
        `Max concurrent positions reached (${open.length}/${this.limits.maxConcurrentPositions}).`,
        draft,
        { open: open.length, limit: this.limits.maxConcurrentPositions },
      );
    }
    const perStrategy = open.filter(
      (p) => p.strategyId === draft.strategyId,
    ).length;
    if (perStrategy >= this.limits.maxPositionsPerStrategy) {
      return this.reject(
        "max_positions_per_strategy",
        `Max positions for ${draft.strategyId} reached (${perStrategy}/${this.limits.maxPositionsPerStrategy}).`,
        draft,
        { perStrategy, limit: this.limits.maxPositionsPerStrategy },
      );
    }
    const perTicker = open.filter((p) => p.ticker === draft.ticker).length;
    if (perTicker >= this.limits.maxPositionsPerTicker) {
      return this.reject(
        "max_positions_per_ticker",
        `Max positions in ${draft.ticker} reached (${perTicker}/${this.limits.maxPositionsPerTicker}).`,
        draft,
        { perTicker, limit: this.limits.maxPositionsPerTicker },
      );
    }

    // 4. Per-trade risk sizing: fit whole shares inside the risk budget.
    const stopDistance = Math.abs(draft.entry - draft.stop);
    const riskBudgetUsd = (ctx.equity * this.limits.maxRiskPerTradePct) / 100;
    const qty = Math.floor(riskBudgetUsd / stopDistance);
    if (qty < 1) {
      return this.reject(
        "per_trade_risk",
        `Stop distance ${roundCents(stopDistance)} is too wide to size ≥1 share within the ${this.limits.maxRiskPerTradePct}% risk budget ($${roundCents(riskBudgetUsd)}).`,
        draft,
        {
          stopDistance,
          riskBudgetUsd: roundCents(riskBudgetUsd),
          maxRiskPerTradePct: this.limits.maxRiskPerTradePct,
        },
      );
    }
    const riskUsd = roundCents(qty * stopDistance);
    const riskPct = roundPct((riskUsd / ctx.equity) * 100);

    // 5. Total open risk across the book must stay within the cap.
    const existingRiskUsd = open.reduce(
      (sum, p) => sum + RiskManager.positionRisk(p),
      0,
    );
    const totalRiskPct = roundPct(
      ((existingRiskUsd + riskUsd) / ctx.equity) * 100,
    );
    if (totalRiskPct > this.limits.maxTotalOpenRiskPct) {
      return this.reject(
        "total_open_risk",
        `Total open risk ${totalRiskPct}% would exceed the ${this.limits.maxTotalOpenRiskPct}% cap.`,
        draft,
        {
          existingRiskUsd: roundCents(existingRiskUsd),
          newRiskUsd: riskUsd,
          totalRiskPct,
          limit: this.limits.maxTotalOpenRiskPct,
        },
      );
    }

    // Approved — build and validate the finalized proposal.
    const ttl = ctx.proposalTtlMs ?? DEFAULT_PROPOSAL_TTL_MS;
    const proposal = TradeProposalSchema.parse({
      signalId: draft.signalId,
      strategyId: draft.strategyId,
      ticker: draft.ticker,
      side: draft.side,
      qty,
      entry: draft.entry,
      stop: draft.stop,
      target: draft.target,
      exitPlan: draft.exitPlan,
      riskUsd,
      riskPct,
      status: "pending",
      executionTarget: ctx.executionTarget,
      expiry: new Date(ctx.now.getTime() + ttl),
    });
    return { approved: true, proposal };
  }

  /**
   * Check the day's realized+unrealized P&L against the −N% daily loss limit
   * (spec §5). When breached, returns a `tripped` result with a critical
   * kill-switch event for the caller to act on (block orders, all strategies →
   * WATCH, notify — the actual trip is T1.3's service).
   *
   * @param dayPnlUsd - net P&L for the day in USD (negative = loss)
   * @param equity - account equity in USD
   */
  checkDailyLoss(dayPnlUsd: number, equity: number): DailyLossResult {
    const dayPnlPct = roundPct((dayPnlUsd / equity) * 100);
    if (dayPnlPct <= -this.limits.dailyLossLimitPct) {
      return {
        tripped: true,
        event: RiskEventSchema.parse({
          rule: "daily_loss_limit",
          reason: `Day P&L ${dayPnlPct}% breached the -${this.limits.dailyLossLimitPct}% daily loss limit; tripping the kill switch.`,
          severity: "critical",
          context: {
            dayPnlUsd: roundCents(dayPnlUsd),
            dayPnlPct,
            equity,
            limitPct: this.limits.dailyLossLimitPct,
          },
        }),
      };
    }
    return { tripped: false };
  }
}
