/**
 * Persistence for backtest reports (T3.5). Writes one `backtest_runs` row per
 * variant and reads them back for the variant-comparison tab. The whole
 * {@link BacktestReport} is stored as JSON (the UI renders it verbatim), with
 * `replayStubbed` denormalised so the `REPLAY_STUBBED` caveat is queryable.
 */
import { Inject, Injectable } from "@nestjs/common";
import { schema, and, desc, eq } from "@magpie/db";
import type { BacktestReport } from "@magpie/core";
import { DB_CLIENT, type DbClient } from "../infra/infra.module.js";
import type { BacktestRunResult } from "./backtest-runner.js";

/** A persisted backtest run as returned to the API/UI. */
export interface StoredBacktestRun {
  readonly id: string;
  readonly strategyId: string;
  readonly instanceId: string;
  readonly label: string;
  readonly params: Record<string, unknown>;
  readonly from: string;
  readonly to: string;
  readonly bars: number;
  readonly report: BacktestReport;
  readonly replayStubbed: boolean;
  readonly createdAt: string;
}

@Injectable()
export class BacktestReportStore {
  constructor(@Inject(DB_CLIENT) private readonly dbClient: DbClient) {}

  /** Persist one variant's report; returns the new row id. */
  async save(run: BacktestRunResult): Promise<string> {
    const [row] = await this.dbClient.db
      .insert(schema.backtestRuns)
      .values({
        strategyId: run.meta.strategyId,
        instanceId: run.meta.instanceId,
        label: run.meta.label,
        params: run.variantParams,
        fromTs: new Date(run.meta.from),
        toTs: new Date(run.meta.to),
        bars: run.meta.bars,
        report: run.report as unknown as Record<string, unknown>,
        replayStubbed: run.report.replayStubbed,
      })
      .returning({ id: schema.backtestRuns.id });
    return row!.id;
  }

  /**
   * Latest run per variant for a strategy, newest first — the comparison rows.
   * (Returns every stored run; the UI can group by `instanceId` and take the
   * most recent. Kept simple: strategies backtest a handful of variants.)
   */
  async listForStrategy(strategyId: string): Promise<StoredBacktestRun[]> {
    const rows = await this.dbClient.db
      .select()
      .from(schema.backtestRuns)
      .where(eq(schema.backtestRuns.strategyId, strategyId))
      .orderBy(desc(schema.backtestRuns.createdAt));
    return rows.map((r) => ({
      id: r.id,
      strategyId: r.strategyId,
      instanceId: r.instanceId,
      label: r.label,
      params: r.params,
      from: r.fromTs.toISOString(),
      to: r.toTs.toISOString(),
      bars: r.bars,
      report: r.report as unknown as BacktestReport,
      replayStubbed: r.replayStubbed,
      createdAt: r.createdAt.toISOString(),
    }));
  }

  /** Most recent run for a single variant instance (or null). */
  async latestForInstance(
    strategyId: string,
    instanceId: string,
  ): Promise<StoredBacktestRun | null> {
    const [row] = await this.dbClient.db
      .select()
      .from(schema.backtestRuns)
      .where(
        and(
          eq(schema.backtestRuns.strategyId, strategyId),
          eq(schema.backtestRuns.instanceId, instanceId),
        ),
      )
      .orderBy(desc(schema.backtestRuns.createdAt))
      .limit(1);
    if (!row) return null;
    return {
      id: row.id,
      strategyId: row.strategyId,
      instanceId: row.instanceId,
      label: row.label,
      params: row.params,
      from: row.fromTs.toISOString(),
      to: row.toTs.toISOString(),
      bars: row.bars,
      report: row.report as unknown as BacktestReport,
      replayStubbed: row.replayStubbed,
      createdAt: row.createdAt.toISOString(),
    };
  }
}
