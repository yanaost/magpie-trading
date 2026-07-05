/**
 * Open/closed positions and the exit actions a strategy can request (spec §3.1,
 * §7). `Position` is persisted to `positions` and pushed to the UI, so it is
 * fully validated. `ExitAction` is what `Strategy.manage` returns each bar; it
 * is small but money-critical (it drives bracket modifications), so it too has
 * a schema — modeled as a discriminated union on `kind`.
 */
import { z } from "zod";
import { TickerSchema } from "./market.js";
import {
  ExecutionTargetSchema,
  PositionStatusSchema,
  SideSchema,
} from "./enums.js";

/** A positive, finite price. */
const PriceSchema = z.number().finite().positive();

/** An open or closed position across any rung (spec §7 `positions`). */
export const PositionSchema = z.object({
  /** DB id, absent until persisted. */
  id: z.string().uuid().optional(),
  /** Strategy that owns the position. */
  strategyId: z.string().min(1),
  /** Sim portfolio this belongs to, for SIM positions. */
  simPortfolioId: z.string().uuid().optional(),
  /** Which rung the position lives on. */
  target: ExecutionTargetSchema,
  /** Symbol held. */
  ticker: TickerSchema,
  /** Long or short. */
  side: SideSchema,
  /** Open or closed. */
  status: PositionStatusSchema.default("open"),
  /** Current quantity (0 once fully closed). */
  qty: z.number().finite().nonnegative(),
  /** Average entry price. */
  avgEntryPrice: PriceSchema,
  /** Average exit price, once (partially) closed. */
  avgExitPrice: PriceSchema.optional(),
  /** Current live stop price, if a stop is working. */
  stopPrice: PriceSchema.optional(),
  /** Realized P&L in USD. */
  realizedPnl: z.number().finite().default(0),
  /** Unrealized P&L in USD (marked to last). */
  unrealizedPnl: z.number().finite().default(0),
  /** When the position opened. */
  openedAt: z.coerce.date(),
  /** When the position closed, if closed. */
  closedAt: z.coerce.date().optional(),
});
/** An open or closed position. */
export type Position = z.infer<typeof PositionSchema>;

/**
 * An exit action requested by `Strategy.manage` (spec §3.1, §4.3). A `null`
 * return means "hold, no change". Each variant is discriminated by `kind` and
 * carries a `reason` recorded to the journal.
 */
export const ExitActionSchema = z.discriminatedUnion("kind", [
  z.object({
    /** Close the whole position (or `qty` of it) now. */
    kind: z.literal("close"),
    /** Partial-close quantity; omitted means close everything. */
    qty: z.number().finite().positive().optional(),
    /** Why (recorded to the journal). */
    reason: z.string().min(1),
  }),
  z.object({
    /** Move the working stop to `newStopPrice`. */
    kind: z.literal("modify-stop"),
    /** New stop price. */
    newStopPrice: PriceSchema,
    /** Why. */
    reason: z.string().min(1),
  }),
  z.object({
    /** Move the working take-profit to `newTargetPrice`. */
    kind: z.literal("modify-target"),
    /** New target price. */
    newTargetPrice: PriceSchema,
    /** Why. */
    reason: z.string().min(1),
  }),
  z.object({
    /** Scale out `qty` at market, keeping the rest. */
    kind: z.literal("scale-out"),
    /** Quantity to reduce by. */
    qty: z.number().finite().positive(),
    /** Why. */
    reason: z.string().min(1),
  }),
]);
/** An exit instruction from `Strategy.manage`, or `null` to hold. */
export type ExitAction = z.infer<typeof ExitActionSchema>;
