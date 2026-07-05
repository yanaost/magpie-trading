/**
 * Drizzle-backed persistence for the signal pipeline (T1.6). Each class
 * implements one port from `pipeline.types.ts`; the orchestrator stays I/O-free
 * and these translate its emitted data into rows. Numeric money-path columns are
 * `numeric` (string mode), so values are stringified on write and `Number()`-ed
 * on read.
 */
import { Inject, Injectable, Logger } from "@nestjs/common";
import { schema, and, eq } from "@magpie/db";
import {
  DEFAULT_RISK_PARAMS,
  RiskManager,
  type QuantSignal,
  type RiskEvent,
  type Strategy,
  type TradeProposal,
} from "@magpie/core";
import { DB_CLIENT, type DbClient } from "../infra/infra.module.js";
import { STRATEGY_INSTANCES } from "./pipeline.providers.js";
import type {
  JournalEntry,
  JournalSink,
  PendingProposal,
  PipelineAuditEntry,
  PipelineAuditSink,
  ProposalStore,
  RiskEventStore,
  SignalStore,
  StrategyRegistry,
  StrategyRuntime,
} from "./pipeline.types.js";

/** Persists quant signals. */
@Injectable()
export class DrizzleSignalStore implements SignalStore {
  constructor(@Inject(DB_CLIENT) private readonly dbClient: DbClient) {}
  async persist(signal: QuantSignal): Promise<{ id: string }> {
    const [row] = await this.dbClient.db
      .insert(schema.signals)
      .values({
        strategyId: signal.strategyId,
        ticker: signal.ticker,
        trigger: signal.trigger,
        quantMetrics: signal.quantMetrics ?? {},
      })
      .returning({ id: schema.signals.id });
    if (!row) throw new Error("signal insert returned no row");
    return { id: row.id };
  }
}

/** Persists proposals and drives their lifecycle. */
@Injectable()
export class DrizzleProposalStore implements ProposalStore {
  constructor(@Inject(DB_CLIENT) private readonly dbClient: DbClient) {}

  async persist(proposal: TradeProposal): Promise<{ id: string }> {
    if (!proposal.signalId) {
      throw new Error("cannot persist a proposal without a signalId");
    }
    const [row] = await this.dbClient.db
      .insert(schema.proposals)
      .values({
        signalId: proposal.signalId,
        strategyId: proposal.strategyId,
        ticker: proposal.ticker,
        side: proposal.side,
        qty: proposal.qty.toString(),
        entry: proposal.entry.toString(),
        stop: proposal.stop.toString(),
        target: proposal.target?.toString() ?? null,
        exitPlan: proposal.exitPlan as unknown as Record<string, unknown>,
        riskUsd: proposal.riskUsd.toString(),
        riskPct: proposal.riskPct.toString(),
        status: proposal.status,
        executionTarget: proposal.executionTarget,
        expiry: proposal.expiry,
      })
      .returning({ id: schema.proposals.id });
    if (!row) throw new Error("proposal insert returned no row");
    return { id: row.id };
  }

  async markExecuted(id: string, at: Date): Promise<void> {
    await this.dbClient.db
      .update(schema.proposals)
      .set({ status: "executed", decidedBy: "auto", decidedAt: at })
      .where(eq(schema.proposals.id, id));
  }

  async listPending(): Promise<PendingProposal[]> {
    const rows = await this.dbClient.db
      .select()
      .from(schema.proposals)
      .where(eq(schema.proposals.status, "pending"));
    return rows.map((r) => ({
      id: r.id,
      strategyId: r.strategyId,
      expiry: r.expiry,
      snapshot: {
        status: r.status,
        ticker: r.ticker,
        side: r.side,
        qty: Number(r.qty),
      },
    }));
  }

  async expire(id: string, at: Date): Promise<void> {
    // Guarded on status so a concurrent approval/execution wins the race.
    await this.dbClient.db
      .update(schema.proposals)
      .set({ status: "expired", decidedAt: at })
      .where(
        and(
          eq(schema.proposals.id, id),
          eq(schema.proposals.status, "pending"),
        ),
      );
  }
}

/** Persists risk-rule events. */
@Injectable()
export class DrizzleRiskEventStore implements RiskEventStore {
  constructor(@Inject(DB_CLIENT) private readonly dbClient: DbClient) {}
  async persist(event: RiskEvent, proposalId?: string): Promise<void> {
    await this.dbClient.db.insert(schema.riskEvents).values({
      strategyId: event.strategyId ?? null,
      proposalId: proposalId ?? null,
      rule: event.rule,
      reason: event.reason,
      context: event.context ?? null,
    });
  }
}

/** Append-only journal sink. */
@Injectable()
export class DrizzleJournalSink implements JournalSink {
  constructor(@Inject(DB_CLIENT) private readonly dbClient: DbClient) {}
  async append(entry: JournalEntry): Promise<void> {
    await this.dbClient.db.insert(schema.journalEntries).values({
      strategyId: entry.strategyId ?? null,
      entryType: entry.entryType,
      refType: entry.refType ?? null,
      refId: entry.refId ?? null,
      title: entry.title,
      body: entry.body ?? null,
      meta: entry.meta ?? null,
    });
  }
}

/** Append-only audit sink for money-path state changes. */
@Injectable()
export class DrizzlePipelineAuditSink implements PipelineAuditSink {
  constructor(@Inject(DB_CLIENT) private readonly dbClient: DbClient) {}
  async append(entry: PipelineAuditEntry): Promise<void> {
    await this.dbClient.db.insert(schema.auditLog).values({
      entityType: entry.entityType,
      entityId: entry.entityId,
      action: entry.action,
      actor: entry.actor,
      before: entry.before,
      after: entry.after,
    });
  }
}

/**
 * Resolves runtimes by joining the DB `strategies` row (live mode / target /
 * risk overrides) with the registered code instance. A strategy row with no
 * code instance is skipped (logged) — the pipeline can only run strategies it
 * has plugin code for. Risk params are the defaults merged with the row's
 * `riskOverrides`.
 */
@Injectable()
export class DrizzleStrategyRegistry implements StrategyRegistry {
  private readonly logger = new Logger(DrizzleStrategyRegistry.name);
  private readonly instances: Map<string, Strategy>;

  constructor(
    @Inject(DB_CLIENT) private readonly dbClient: DbClient,
    @Inject(STRATEGY_INSTANCES) instances: Strategy[],
  ) {
    this.instances = new Map(instances.map((s) => [s.id, s]));
  }

  async getRuntime(strategyId: string): Promise<StrategyRuntime | undefined> {
    const [row] = await this.dbClient.db
      .select()
      .from(schema.strategies)
      .where(eq(schema.strategies.id, strategyId));
    if (!row) return undefined;
    return this.toRuntime(row);
  }

  async all(): Promise<StrategyRuntime[]> {
    const rows = await this.dbClient.db.select().from(schema.strategies);
    return rows
      .map((r) => this.toRuntime(r))
      .filter((r): r is StrategyRuntime => r !== undefined);
  }

  private toRuntime(
    row: typeof schema.strategies.$inferSelect,
  ): StrategyRuntime | undefined {
    const strategy = this.instances.get(row.id);
    if (!strategy) {
      this.logger.debug(
        `strategy row ${row.id} has no registered code instance — skipping`,
      );
      return undefined;
    }
    const riskManager = new RiskManager({
      ...DEFAULT_RISK_PARAMS,
      ...row.riskOverrides,
    });
    return {
      strategy,
      mode: row.mode,
      executionTarget: row.target,
      riskManager,
    };
  }
}
