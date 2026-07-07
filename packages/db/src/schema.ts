/**
 * Drizzle schema — the persistent data model (spec §7).
 *
 * Conventions:
 * - All money/price columns are `numeric` (returned as strings by the driver to
 *   preserve precision — the app converts deliberately; the LLM never touches
 *   these). Prices/ratios use scale 8; cash/P&L/commission use scale 2.
 * - Every table that touches the money path is append-friendly; deletes are
 *   forbidden in the money path (ground rule 7) — enforced in the repository
 *   layer, not by the DB, so audits remain queryable.
 * - `candles` is converted to a TimescaleDB hypertable in a follow-up migration.
 */
import {
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

// --- Enums --------------------------------------------------------------

/** Per-strategy operating mode (spec §2). */
export const modeEnum = pgEnum("mode", ["AUTO", "APPROVE", "WATCH", "OFF"]);
/** Execution target / promotion rung (spec §2.1). */
export const targetEnum = pgEnum("execution_target", ["SIM", "PAPER", "LIVE"]);
/** Strategy timeframe / kind. Superset of spec §3.1 to cover the roster. */
export const timeframeEnum = pgEnum("timeframe", [
  "intraday",
  "swing",
  "weekly",
  "observation",
  "filter",
]);
/** LLM analyst verdict — proceed or veto only (spec §4.2). */
export const verdictEnum = pgEnum("verdict", ["proceed", "veto"]);
/** Trade direction. Options legs are described in the proposal exit_plan. */
export const sideEnum = pgEnum("side", ["long", "short"]);
/** Proposal lifecycle (spec §7). */
export const proposalStatusEnum = pgEnum("proposal_status", [
  "pending",
  "approved",
  "rejected",
  "expired",
  "executed",
]);
/** Who decided a proposal. */
export const decidedByEnum = pgEnum("decided_by", ["user", "auto"]);
/** Broker order lifecycle. */
export const orderStatusEnum = pgEnum("order_status", [
  "pending_submit",
  "submitted",
  "working",
  "filled",
  "cancelled",
  "rejected",
  "expired",
]);
/** Role of an order within a bracket. */
export const bracketRoleEnum = pgEnum("bracket_role", [
  "parent",
  "stop",
  "target",
]);
/** Position lifecycle. */
export const positionStatusEnum = pgEnum("position_status", ["open", "closed"]);
/** Risk event severity. */
export const severityEnum = pgEnum("severity", ["info", "warning", "critical"]);
/** Journal entry kind. */
export const journalEntryTypeEnum = pgEnum("journal_entry_type", [
  "decision",
  "note",
]);

// --- Shared column helpers ---------------------------------------------

const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).defaultNow().notNull();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true }).defaultNow().notNull();
/** price / ratio */
const price = (name: string) => numeric(name, { precision: 20, scale: 8 });
/** cash / pnl / commission */
const money = (name: string) => numeric(name, { precision: 20, scale: 2 });

// --- Tables -------------------------------------------------------------

/** strategies — id, mode, target, config, risk overrides (spec §7). */
export const strategies = pgTable("strategies", {
  id: text("id").primaryKey(), // e.g. "qual-sphb"
  name: text("name").notNull(),
  timeframe: timeframeEnum("timeframe").notNull(),
  mode: modeEnum("mode").notNull().default("WATCH"),
  target: targetEnum("target").notNull().default("SIM"),
  config: jsonb("config")
    .$type<Record<string, unknown>>()
    .notNull()
    .default({}),
  riskOverrides: jsonb("risk_overrides")
    .$type<Record<string, unknown>>()
    .notNull()
    .default({}),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/** signals — quant trigger output for one strategy scan hit (spec §7). */
export const signals = pgTable(
  "signals",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    strategyId: text("strategy_id")
      .notNull()
      .references(() => strategies.id),
    ticker: text("ticker").notNull(),
    trigger: jsonb("trigger").$type<Record<string, unknown>>().notNull(),
    quantMetrics: jsonb("quant_metrics")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    createdAt: createdAt(),
  },
  (t) => [
    index("signals_strategy_idx").on(t.strategyId),
    index("signals_ticker_idx").on(t.ticker),
  ],
);

/**
 * llm_analyses — the full LLM dialog log (spec §7, U1). One append-only row per
 * model call: signal risk analyses AND the nightly crowding scan. Beyond the
 * verdict it stores the complete request (system/user prompt, model params, and
 * any web-search invocations) so the admin can read exactly what Magpie asked
 * and what Claude answered. Failures are first-class rows (`outcome`
 * `veto_by_failure` + `error_text`), never dropped.
 */
export const llmAnalyses = pgTable(
  "llm_analyses",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    /** What kind of call this was: per-signal analysis or the crowding scan. */
    purpose: text("purpose").notNull().default("signal_analysis"),
    /**
     * Owning signal, when the call analyzed one. Nullable: the crowding scan and
     * un-persisted/replay signals have no signal row to reference.
     */
    signalId: uuid("signal_id").references(() => signals.id),
    /** Owning strategy, denormalized for filtering (crowding uses its own id). */
    strategyId: text("strategy_id"),
    /** Symbol under analysis, denormalized for filtering. Null for the scan. */
    ticker: text("ticker"),
    /**
     * The model's verdict — proceed/veto. Nullable: the crowding scan produces
     * no verdict, and a failed call has none (see `outcome`).
     */
    verdict: verdictEnum("verdict"),
    /**
     * What actually happened, always set: "proceed" | "veto" | "veto_by_failure".
     * Failures (timeout, transport, parse, refusal) are recorded here with the
     * error in `error_text` rather than silently dropped.
     */
    outcome: text("outcome"),
    confidence: numeric("confidence", { precision: 5, scale: 4 }), // 0..1
    reasoning: text("reasoning"),
    flaggedRisks: jsonb("flagged_risks")
      .$type<string[]>()
      .notNull()
      .default([]),
    /** Verbatim system prompt sent to the model (never contains secrets). */
    systemPrompt: text("system_prompt"),
    /** Verbatim user-turn text sent to the model. */
    userPrompt: text("user_prompt"),
    /** Request params: model, max_tokens, whether web search was enabled, etc. */
    params: jsonb("params").$type<Record<string, unknown>>(),
    /** Web-search tool invocations the model made, when the SDK surfaced them. */
    webSearches: jsonb("web_searches").$type<{ query: string }[]>(),
    rawResponse: text("raw_response"),
    /** Error text for a failed call (`outcome = veto_by_failure`). */
    errorText: text("error_text"),
    latencyMs: integer("latency_ms"),
    model: text("model").notNull(),
    /**
     * Content hash of the analysis request (strategy, ticker, prompt, context).
     * The replay engine (T3.1) looks analyses up by this to reuse a real verdict
     * instead of re-calling the model. Nullable: rows written before T3.1 have none.
     */
    contextHash: text("context_hash"),
    createdAt: createdAt(),
  },
  (t) => [
    index("llm_analyses_signal_idx").on(t.signalId),
    index("llm_analyses_context_hash_idx").on(t.contextHash),
    index("llm_analyses_purpose_idx").on(t.purpose),
    index("llm_analyses_ticker_idx").on(t.ticker),
    index("llm_analyses_created_idx").on(t.createdAt),
  ],
);

/** proposals — finalized trade proposal awaiting decision/execution (spec §7). */
export const proposals = pgTable(
  "proposals",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    signalId: uuid("signal_id")
      .notNull()
      .references(() => signals.id),
    strategyId: text("strategy_id")
      .notNull()
      .references(() => strategies.id),
    ticker: text("ticker").notNull(),
    side: sideEnum("side").notNull(),
    qty: numeric("qty", { precision: 20, scale: 8 }).notNull(),
    entry: price("entry").notNull(),
    stop: price("stop").notNull(), // mandatory — risk manager rejects without it
    target: price("target"), // optional take-profit
    exitPlan: jsonb("exit_plan").$type<Record<string, unknown>>().notNull(),
    riskUsd: money("risk_usd").notNull(),
    riskPct: numeric("risk_pct", { precision: 8, scale: 4 }).notNull(),
    status: proposalStatusEnum("status").notNull().default("pending"),
    executionTarget: targetEnum("execution_target").notNull(),
    decidedBy: decidedByEnum("decided_by"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    expiry: timestamp("expiry", { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("proposals_status_idx").on(t.status),
    index("proposals_strategy_idx").on(t.strategyId),
  ],
);

/** orders — broker (or sim) orders, bracket-linked (spec §7). */
export const orders = pgTable(
  "orders",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    proposalId: uuid("proposal_id").references(() => proposals.id),
    strategyId: text("strategy_id")
      .notNull()
      .references(() => strategies.id),
    parentOrderId: uuid("parent_order_id"), // self-ref (bracket parent)
    bracketRole: bracketRoleEnum("bracket_role").notNull(),
    target: targetEnum("target").notNull(),
    brokerOrderId: text("broker_order_id"),
    ticker: text("ticker").notNull(),
    side: sideEnum("side").notNull(),
    qty: numeric("qty", { precision: 20, scale: 8 }).notNull(),
    limitPrice: price("limit_price"),
    stopPrice: price("stop_price"),
    status: orderStatusEnum("status").notNull().default("pending_submit"),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    filledAt: timestamp("filled_at", { withTimezone: true }),
    reconciledAt: timestamp("reconciled_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("orders_proposal_idx").on(t.proposalId),
    index("orders_broker_idx").on(t.brokerOrderId),
    index("orders_parent_idx").on(t.parentOrderId),
  ],
);

/** fills — execution reports against an order (spec §7). */
export const fills = pgTable(
  "fills",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id),
    target: targetEnum("target").notNull(),
    brokerExecId: text("broker_exec_id"),
    ticker: text("ticker").notNull(),
    side: sideEnum("side").notNull(),
    qty: numeric("qty", { precision: 20, scale: 8 }).notNull(),
    price: price("price").notNull(),
    commission: money("commission").notNull().default("0"),
    filledAt: timestamp("filled_at", { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("fills_order_idx").on(t.orderId)],
);

/** sim_portfolios — isolated virtual portfolio per strategy instance (spec §7). */
export const simPortfolios = pgTable("sim_portfolios", {
  id: uuid("id").defaultRandom().primaryKey(),
  strategyInstanceId: text("strategy_instance_id").notNull(), // strategyId[:variant]
  variantParams: jsonb("variant_params")
    .$type<Record<string, unknown>>()
    .notNull()
    .default({}),
  startingCash: money("starting_cash").notNull(),
  virtualCash: money("virtual_cash").notNull(),
  createdAt: createdAt(),
  resetAt: timestamp("reset_at", { withTimezone: true }),
  updatedAt: updatedAt(),
});

/** positions — open/closed positions across SIM/PAPER/LIVE (spec §7). */
export const positions = pgTable(
  "positions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    strategyId: text("strategy_id")
      .notNull()
      .references(() => strategies.id),
    simPortfolioId: uuid("sim_portfolio_id").references(() => simPortfolios.id),
    target: targetEnum("target").notNull(),
    ticker: text("ticker").notNull(),
    side: sideEnum("side").notNull(),
    status: positionStatusEnum("status").notNull().default("open"),
    qty: numeric("qty", { precision: 20, scale: 8 }).notNull(),
    avgEntryPrice: price("avg_entry_price").notNull(),
    avgExitPrice: price("avg_exit_price"),
    stopPrice: price("stop_price"),
    realizedPnl: money("realized_pnl").notNull().default("0"),
    unrealizedPnl: money("unrealized_pnl").notNull().default("0"),
    openedAt: timestamp("opened_at", { withTimezone: true }).notNull(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("positions_strategy_idx").on(t.strategyId),
    index("positions_status_idx").on(t.status),
    index("positions_ticker_idx").on(t.ticker),
  ],
);

/** risk_events — every rule that fired, incl. kill-switch trips (spec §7). */
export const riskEvents = pgTable(
  "risk_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    strategyId: text("strategy_id").references(() => strategies.id),
    proposalId: uuid("proposal_id").references(() => proposals.id),
    rule: text("rule").notNull(),
    reason: text("reason").notNull(),
    context: jsonb("context").$type<Record<string, unknown>>(),
    severity: severityEnum("severity").notNull().default("warning"),
    createdAt: createdAt(),
  },
  (t) => [index("risk_events_strategy_idx").on(t.strategyId)],
);

/** crowded_tickers — strategy #6 state, expiring evidence (spec §7). */
export const crowdedTickers = pgTable(
  "crowded_tickers",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    ticker: text("ticker").notNull(),
    sourceEvidence: text("source_evidence").notNull(),
    addedAt: createdAt(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [index("crowded_tickers_ticker_idx").on(t.ticker)],
);

/** journal_entries — auto decisions + free-text notes (spec §7). */
export const journalEntries = pgTable(
  "journal_entries",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    strategyId: text("strategy_id").references(() => strategies.id),
    entryType: journalEntryTypeEnum("entry_type").notNull(),
    refType: text("ref_type"), // proposal | position | signal | ...
    refId: text("ref_id"),
    title: text("title").notNull(),
    body: text("body"),
    meta: jsonb("meta").$type<Record<string, unknown>>(),
    createdAt: createdAt(),
  },
  (t) => [index("journal_strategy_idx").on(t.strategyId)],
);

/** audit_log — append-only record of every money-path state change (spec §7). */
export const auditLog = pgTable(
  "audit_log",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    action: text("action").notNull(),
    actor: text("actor").notNull(), // "user" | "system" | strategyId
    before: jsonb("before").$type<Record<string, unknown>>(),
    after: jsonb("after").$type<Record<string, unknown>>(),
    createdAt: createdAt(),
  },
  (t) => [index("audit_entity_idx").on(t.entityType, t.entityId)],
);

/**
 * kill_switch — the global safety flag (spec §5, T1.3). A singleton row keyed
 * `KILL_SWITCH_ID`. When `active`, the order path blocks all new orders and the
 * service demotes every strategy to `WATCH`. Re-arming requires a typed
 * confirmation and never auto-restores strategy modes.
 */
export const killSwitch = pgTable("kill_switch", {
  id: text("id").primaryKey(),
  active: boolean("active").notNull().default(false),
  reason: text("reason"),
  /** "user" | "system:<rule>" | strategyId */
  trippedBy: text("tripped_by"),
  trippedAt: timestamp("tripped_at", { withTimezone: true }),
  rearmedAt: timestamp("rearmed_at", { withTimezone: true }),
  updatedAt: updatedAt(),
});

/** The singleton primary-key value for the {@link killSwitch} row. */
export const KILL_SWITCH_ID = "global";

/** candles — OHLCV, TimescaleDB hypertable, composite key (spec §7). */
export const candles = pgTable(
  "candles",
  {
    ticker: text("ticker").notNull(),
    timeframe: text("timeframe").notNull(), // "1d" | "5m" | "1w" | ...
    ts: timestamp("ts", { withTimezone: true }).notNull(),
    open: price("open").notNull(),
    high: price("high").notNull(),
    low: price("low").notNull(),
    close: price("close").notNull(),
    volume: numeric("volume", { precision: 20, scale: 2 }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.ticker, t.timeframe, t.ts] })],
);

/**
 * backtest_runs — one persisted §4.4 backtest report per strategy variant
 * (T3.5). A variant (`instanceId`, e.g. `snapback:wait30`) is scored over a
 * window and the whole report — performance, per-rule veto stats, and the
 * stubbing caveat — is stored as JSON so the variant-comparison tab can render
 * comparable rows without re-running. `replayStubbed` is denormalised out of the
 * report so the `REPLAY_STUBBED` caveat is filterable/visible at a glance.
 */
export const backtestRuns = pgTable(
  "backtest_runs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    strategyId: text("strategy_id").notNull(),
    instanceId: text("instance_id").notNull(), // e.g. "snapback:wait30"
    label: text("label").notNull(), // e.g. "30-min wait"
    params: jsonb("params").$type<Record<string, unknown>>().notNull(),
    fromTs: timestamp("from_ts", { withTimezone: true }).notNull(),
    toTs: timestamp("to_ts", { withTimezone: true }).notNull(),
    bars: integer("bars").notNull(),
    // Whole BacktestReport (performance + vetoStats + stubbing), as produced by
    // buildBacktestReport — the UI reads it verbatim.
    report: jsonb("report").$type<Record<string, unknown>>().notNull(),
    replayStubbed: boolean("replay_stubbed").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("backtest_runs_strategy_idx").on(t.strategyId, t.instanceId)],
);
