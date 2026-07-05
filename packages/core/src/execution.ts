/**
 * The execution port (spec §3.1, §4.3, §4.4) — the single interface behind
 * which both the in-app simulator and the real IB execution service live, so a
 * strategy cannot tell SIM from PAPER/LIVE. Every entry is placed as a bracket
 * (parent + stop + optional take-profit) so exits survive crashes and gateway
 * restarts. Order/fill payloads cross the process↔broker↔db boundary and carry
 * zod schemas; the port itself is a behavioral interface.
 */
import { z } from "zod";
import { TickerSchema } from "./market.js";
import {
  BracketRoleSchema,
  ExecutionTargetSchema,
  OrderStatusSchema,
  SideSchema,
} from "./enums.js";

/** A positive, finite price. */
const PriceSchema = z.number().finite().positive();

/** How the parent entry order is priced. */
export const EntryTypeSchema = z.enum(["market", "limit"]);
/** Whether the bracket's entry leg is a market or limit order. */
export type EntryType = z.infer<typeof EntryTypeSchema>;

/** Time-in-force for the entry order. */
export const TimeInForceSchema = z.enum(["DAY", "GTC"]);
/** Order time-in-force. */
export type TimeInForce = z.infer<typeof TimeInForceSchema>;

/**
 * A request to place one bracket. `stopPrice` is mandatory (exit-before-entry);
 * `limitPrice` is required for a limit entry and ignored for market. Built only
 * by the execution service from a risk-approved {@link import("./proposal.js").TradeProposal}.
 */
export const BracketOrderRequestSchema = z
  .object({
    /** Strategy placing the order. */
    strategyId: z.string().min(1),
    /** Proposal this bracket executes, when persisted. */
    proposalId: z.string().uuid().optional(),
    /** Rung to route to. */
    target: ExecutionTargetSchema,
    /** Symbol to trade. */
    ticker: TickerSchema,
    /** Long or short. */
    side: SideSchema,
    /** Quantity (shares/contracts). */
    qty: z.number().finite().positive(),
    /** Market or limit entry. */
    entryType: EntryTypeSchema,
    /** Limit price — required when `entryType` is "limit". */
    limitPrice: PriceSchema.optional(),
    /** Mandatory protective stop price. */
    stopPrice: PriceSchema,
    /** Optional take-profit price. */
    targetPrice: PriceSchema.optional(),
    /** Time-in-force (defaults to DAY). */
    timeInForce: TimeInForceSchema.default("DAY"),
  })
  .refine((r) => r.entryType !== "limit" || r.limitPrice !== undefined, {
    message: "limitPrice is required for a limit entry",
    path: ["limitPrice"],
  });
/** A validated request to place a protective bracket order. */
export type BracketOrderRequest = z.infer<typeof BracketOrderRequestSchema>;

/**
 * A modification to a working bracket — the app-side smart-exit path
 * (`Strategy.manage`). Qty may only be reduced; the execution layer enforces
 * downward-only sizing (never averages up into a position).
 */
export const OrderModificationSchema = z.object({
  /** Bracket to modify. */
  bracketId: z.string().min(1),
  /** New stop price, when trailing/tightening the stop. */
  newStopPrice: PriceSchema.optional(),
  /** New take-profit price. */
  newTargetPrice: PriceSchema.optional(),
  /** New (reduced) quantity for partial exits. */
  newQty: z.number().finite().positive().optional(),
});
/** A modification to a working bracket. */
export type OrderModification = z.infer<typeof OrderModificationSchema>;

/** A reference to one order leg as tracked by the port (spec §7 `orders`). */
export const OrderRefSchema = z.object({
  /** App order id. */
  orderId: z.string().min(1),
  /** Broker's order id, once assigned. */
  brokerOrderId: z.string().optional(),
  /** Which bracket leg this is. */
  role: BracketRoleSchema,
  /** Lifecycle status. */
  status: OrderStatusSchema,
  /** Symbol. */
  ticker: TickerSchema,
  /** Long or short. */
  side: SideSchema,
  /** Quantity. */
  qty: z.number().finite().positive(),
  /** Limit price, if any. */
  limitPrice: PriceSchema.optional(),
  /** Stop price, if any. */
  stopPrice: PriceSchema.optional(),
});
/** A reference to one tracked order leg. */
export type OrderRef = z.infer<typeof OrderRefSchema>;

/** A handle to a placed bracket and its constituent legs. */
export const BracketHandleSchema = z.object({
  /** Stable id for the whole bracket (the parent's id). */
  bracketId: z.string().min(1),
  /** Parent entry order. */
  parent: OrderRefSchema,
  /** Protective stop order. */
  stop: OrderRefSchema,
  /** Take-profit order, when one was requested. */
  target: OrderRefSchema.optional(),
});
/** A handle to a placed bracket. */
export type BracketHandle = z.infer<typeof BracketHandleSchema>;

/** An execution report against an order (spec §7 `fills`). */
export const FillSchema = z.object({
  /** DB id, absent until persisted. */
  id: z.string().uuid().optional(),
  /** Order this fill is against. */
  orderId: z.string().min(1),
  /** Rung the fill occurred on. */
  target: ExecutionTargetSchema,
  /** Broker execution id, for reconciliation. */
  brokerExecId: z.string().optional(),
  /** Symbol. */
  ticker: TickerSchema,
  /** Long or short. */
  side: SideSchema,
  /** Filled quantity. */
  qty: z.number().finite().positive(),
  /** Fill price. */
  price: PriceSchema,
  /** Commission charged (USD). */
  commission: z.number().finite().nonnegative().default(0),
  /** When the fill occurred. */
  filledAt: z.coerce.date(),
});
/** An execution report (fill). */
export type Fill = z.infer<typeof FillSchema>;

/**
 * The execution port. Both the simulator and the IB execution service implement
 * this identically (spec §4.4); the pipeline is agnostic to which is behind it.
 */
export interface ExecutionPort {
  /** Which rung this port drives. */
  readonly target: import("./enums.js").ExecutionTarget;
  /**
   * Place a protective bracket (parent + stop + optional target).
   * @param req - validated bracket request
   * @returns a handle to the placed bracket
   * @throws {@link LivePromotionLockedError} if `target` is "LIVE" (MVP lock)
   */
  placeBracket(req: BracketOrderRequest): Promise<BracketHandle>;
  /**
   * Modify a working bracket (trail the stop, move the target, partial exit).
   * @param mod - the modification to apply
   */
  modifyBracket(mod: OrderModification): Promise<void>;
  /**
   * Cancel a working bracket and its legs.
   * @param bracketId - the bracket to cancel
   */
  cancelBracket(bracketId: string): Promise<void>;
  /**
   * Current positions on this rung, optionally filtered to one strategy.
   * @param strategyId - when given, only this strategy's positions
   */
  getPositions(
    strategyId?: string,
  ): Promise<import("./position.js").Position[]>;
  /**
   * Fills on this rung since an optional cutoff, for reconciliation.
   * @param since - only fills at or after this time
   */
  getFills(since?: Date): Promise<Fill[]>;
}

/**
 * Thrown by any execution port when a `LIVE` order is attempted. Live trading is
 * locked in code for the MVP (ground rule 3 / spec §2.1); promotion to LIVE is a
 * deliberate future milestone, never reachable by accident.
 */
export class LivePromotionLockedError extends Error {
  /**
   * @param detail - optional context appended to the message
   */
  constructor(detail?: string) {
    super(
      `LIVE execution is locked${detail ? `: ${detail}` : ""}. ` +
        "Promotion to LIVE is a gated future milestone.",
    );
    this.name = "LivePromotionLockedError";
  }
}
