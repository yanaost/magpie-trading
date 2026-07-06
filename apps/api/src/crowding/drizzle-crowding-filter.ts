/**
 * DB-backed {@link CrowdingFilter} (strategy #6, T2.4). A ticker is "crowded" if
 * the `crowded_tickers` store holds a non-expired row for it; the most recent
 * such row supplies the evidence surfaced in the veto journal entry. Reads only
 * — the nightly {@link CrowdingRefreshService} owns writes.
 */
import { Inject, Injectable } from "@nestjs/common";
import { schema, and, eq, gt, desc } from "@magpie/db";
import type { Ticker } from "@magpie/core";
import { DB_CLIENT, type DbClient } from "../infra/infra.module.js";
import {
  PIPELINE_CLOCK,
  type CrowdingFilter,
  type CrowdingStatus,
  type Clock,
} from "../pipeline/pipeline.types.js";

@Injectable()
export class DrizzleCrowdingFilter implements CrowdingFilter {
  constructor(
    @Inject(DB_CLIENT) private readonly dbClient: DbClient,
    @Inject(PIPELINE_CLOCK) private readonly clock: Clock,
  ) {}

  async check(ticker: Ticker): Promise<CrowdingStatus> {
    const now = this.clock.now();
    const [row] = await this.dbClient.db
      .select({ evidence: schema.crowdedTickers.sourceEvidence })
      .from(schema.crowdedTickers)
      .where(
        and(
          eq(schema.crowdedTickers.ticker, ticker),
          gt(schema.crowdedTickers.expiresAt, now),
        ),
      )
      .orderBy(desc(schema.crowdedTickers.addedAt))
      .limit(1);
    if (!row) return { crowded: false };
    return { crowded: true, evidence: row.evidence };
  }
}
