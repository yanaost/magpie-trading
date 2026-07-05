/**
 * Trade proposals (spec §3.1, §4.2, §7). Two shapes, deliberately separated:
 *
 * - {@link ProposalDraft} is what a strategy's `buildProposal` returns — the
 *   trade idea with entry, stop, optional target and a written exit plan. It
 *   carries a *requested* size only.
 * - {@link TradeProposal} is the risk-finalized, persisted proposal. The risk
 *   manager (T1.2) owns sizing and stamps `riskUsd`/`riskPct`; it may reduce the
 *   requested qty but never enlarge it. The LLM never touches any of these
 *   numbers (spec §4.2).
 *
 * The exit is written before the entry: a `stop` and an `exitPlan` are
 * mandatory (spec §3.1), so the schemas require them.
 */
import { z } from "zod";
import { TickerSchema } from "./market.js";
import {
  DecidedBySchema,
  ExecutionTargetSchema,
  ProposalStatusSchema,
  SideSchema,
} from "./enums.js";

/** A positive, finite price (entry/stop/target). */
const PriceSchema = z.number().finite().positive();

/**
 * Structured exit plan attached to a proposal — the smarter, app-side exits
 * enforced by `Strategy.manage` (spec §4.3). Persisted as `proposals.exit_plan`
 * jsonb. `stopLoss` mirrors the proposal's hard stop and is always present.
 */
export const ExitPlanSchema = z.object({
  /** Hard stop-loss price (mirrors `TradeProposal.stop`). Mandatory. */
  stopLoss: PriceSchema,
  /** Take-profit price, when the strategy defines one. */
  takeProfit: PriceSchema.optional(),
  /** Time-based exit rules. */
  timeStop: z
    .object({
      /** Flatten before the close (intraday strategies). */
      flatByClose: z.boolean().optional(),
      /** Max bars to hold before forced exit. */
      maxHoldBars: z.number().int().positive().optional(),
    })
    .optional(),
  /** Trailing-stop rule, e.g. trail under the 5-day MA. */
  trailing: z
    .object({
      /** Reference the trail follows. */
      type: z.enum(["ma", "atr", "pct"]),
      /** Parameter for the reference (MA length, ATR mult, or percent). */
      param: z.number().finite().positive(),
    })
    .optional(),
  /** Human-readable exit rules surfaced in the strategy tab. */
  rules: z.array(z.string()).default([]),
  /** Free-text notes. */
  notes: z.string().optional(),
});
/** The written exit plan for a proposal (exit-before-entry). */
export type ExitPlan = z.infer<typeof ExitPlanSchema>;

/**
 * A strategy's trade idea before risk finalization. Carries a *requested* size;
 * the risk manager may reduce it. Not persisted directly — it becomes a
 * {@link TradeProposal} once sized and limit-checked.
 */
export const ProposalDraftSchema = z.object({
  /** Strategy proposing the trade. */
  strategyId: z.string().min(1),
  /** Signal that led to this proposal, when persisted. */
  signalId: z.string().uuid().optional(),
  /** Symbol to trade. */
  ticker: TickerSchema,
  /** Long or short. */
  side: SideSchema,
  /** Requested quantity (shares/contracts) — subject to risk downsizing. */
  requestedQty: z.number().finite().positive(),
  /** Intended entry price. */
  entry: PriceSchema,
  /** Mandatory stop-loss price (risk manager rejects proposals without it). */
  stop: PriceSchema,
  /** Optional take-profit price. */
  target: PriceSchema.optional(),
  /** Written exit plan (mandatory). */
  exitPlan: ExitPlanSchema,
});
/** A pre-sizing trade idea returned by `Strategy.buildProposal`. */
export type ProposalDraft = z.infer<typeof ProposalDraftSchema>;

/**
 * A risk-finalized, persisted trade proposal (spec §7 `proposals`). `qty`,
 * `riskUsd` and `riskPct` are set by the risk manager; `status` drives the
 * approve/execute/expire lifecycle. Sent to the UI and Telegram, so it crosses
 * boundaries and is fully validated.
 */
export const TradeProposalSchema = z.object({
  /** DB id, absent until persisted. */
  id: z.string().uuid().optional(),
  /** Signal that led to this proposal. */
  signalId: z.string().uuid().optional(),
  /** Strategy that owns the proposal. */
  strategyId: z.string().min(1),
  /** Symbol to trade. */
  ticker: TickerSchema,
  /** Long or short. */
  side: SideSchema,
  /** Final, risk-approved quantity (≤ the draft's requested qty). */
  qty: z.number().finite().positive(),
  /** Entry price. */
  entry: PriceSchema,
  /** Mandatory stop-loss price. */
  stop: PriceSchema,
  /** Optional take-profit price. */
  target: PriceSchema.optional(),
  /** Written exit plan. */
  exitPlan: ExitPlanSchema,
  /** Capital at risk in USD (stop distance × qty), set by the risk manager. */
  riskUsd: z.number().finite().nonnegative(),
  /** Capital at risk as % of equity, set by the risk manager. */
  riskPct: z.number().finite().nonnegative(),
  /** Lifecycle status. */
  status: ProposalStatusSchema.default("pending"),
  /** Which rung this proposal executes against. */
  executionTarget: ExecutionTargetSchema,
  /** Who decided it (user vs auto), once decided. */
  decidedBy: DecidedBySchema.optional(),
  /** When it was decided. */
  decidedAt: z.coerce.date().optional(),
  /** Expiry — proposals auto-expire after their TTL (spec §2). */
  expiry: z.coerce.date(),
  /** Creation time, assigned by the DB when absent. */
  createdAt: z.coerce.date().optional(),
});
/** A risk-finalized trade proposal awaiting decision/execution. */
export type TradeProposal = z.infer<typeof TradeProposalSchema>;
