/**
 * Domain enums — the single source of truth for the small closed vocabularies
 * used across the money path. Each enum is declared once as a `readonly` tuple,
 * wrapped in a zod schema (for payloads that cross a process/db boundary), and
 * exported as a TypeScript union type. Values mirror the Drizzle `pgEnum`
 * definitions in `@magpie/db` exactly (spec §2, §7).
 */
import { z } from "zod";

/** Per-strategy operating mode (spec §2). */
export const MODES = ["AUTO", "APPROVE", "WATCH", "OFF"] as const;
/** Zod schema for {@link Mode}. */
export const ModeSchema = z.enum(MODES);
/** How a strategy acts on signals: auto-execute, ask, observe, or idle. */
export type Mode = z.infer<typeof ModeSchema>;

/** Execution target / promotion rung (spec §2.1). */
export const EXECUTION_TARGETS = ["SIM", "PAPER", "LIVE"] as const;
/** Zod schema for {@link ExecutionTarget}. */
export const ExecutionTargetSchema = z.enum(EXECUTION_TARGETS);
/** Where orders route: in-app simulator, IB paper, or the real account. */
export type ExecutionTarget = z.infer<typeof ExecutionTargetSchema>;

/** Strategy timeframe / kind. Superset of spec §3.1 to cover the roster. */
export const STRATEGY_TIMEFRAMES = [
  "intraday",
  "swing",
  "weekly",
  "observation",
  "filter",
] as const;
/** Zod schema for {@link StrategyTimeframe}. */
export const StrategyTimeframeSchema = z.enum(STRATEGY_TIMEFRAMES);
/** The cadence/kind of a strategy (drives scheduling and UI grouping). */
export type StrategyTimeframe = z.infer<typeof StrategyTimeframeSchema>;

/** LLM analyst verdict — proceed or veto only (spec §4.2). */
export const VERDICTS = ["proceed", "veto"] as const;
/** Zod schema for {@link Verdict}. */
export const VerdictSchema = z.enum(VERDICTS);
/** The only two things the LLM is allowed to decide. */
export type Verdict = z.infer<typeof VerdictSchema>;

/** Trade direction. Options legs are described in the proposal exit plan. */
export const SIDES = ["long", "short"] as const;
/** Zod schema for {@link Side}. */
export const SideSchema = z.enum(SIDES);
/** Whether a position is long or short the underlying. */
export type Side = z.infer<typeof SideSchema>;

/** Proposal lifecycle (spec §7). */
export const PROPOSAL_STATUSES = [
  "pending",
  "approved",
  "rejected",
  "expired",
  "executed",
] as const;
/** Zod schema for {@link ProposalStatus}. */
export const ProposalStatusSchema = z.enum(PROPOSAL_STATUSES);
/** Where a proposal sits in the approve/execute/expire lifecycle. */
export type ProposalStatus = z.infer<typeof ProposalStatusSchema>;

/** Who decided a proposal (spec §7). */
export const DECIDED_BY = ["user", "auto"] as const;
/** Zod schema for {@link DecidedBy}. */
export const DecidedBySchema = z.enum(DECIDED_BY);
/** Whether a human approved the proposal or `AUTO` mode did. */
export type DecidedBy = z.infer<typeof DecidedBySchema>;

/** Broker (or sim) order lifecycle (spec §7). */
export const ORDER_STATUSES = [
  "pending_submit",
  "submitted",
  "working",
  "filled",
  "cancelled",
  "rejected",
  "expired",
] as const;
/** Zod schema for {@link OrderStatus}. */
export const OrderStatusSchema = z.enum(ORDER_STATUSES);
/** Lifecycle state of a single order leg. */
export type OrderStatus = z.infer<typeof OrderStatusSchema>;

/** Role of an order within a bracket (spec §4.3). */
export const BRACKET_ROLES = ["parent", "stop", "target"] as const;
/** Zod schema for {@link BracketRole}. */
export const BracketRoleSchema = z.enum(BRACKET_ROLES);
/** Which leg of the parent + stop + take-profit bracket an order is. */
export type BracketRole = z.infer<typeof BracketRoleSchema>;

/** Position lifecycle (spec §7). */
export const POSITION_STATUSES = ["open", "closed"] as const;
/** Zod schema for {@link PositionStatus}. */
export const PositionStatusSchema = z.enum(POSITION_STATUSES);
/** Whether a position is currently open or has been fully closed. */
export type PositionStatus = z.infer<typeof PositionStatusSchema>;
