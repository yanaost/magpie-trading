/**
 * Nightly crowding-refresh job (strategy #6, T2.4). Asks the
 * {@link CrowdingResearcher} for the currently over-recommended tickers and
 * rewrites the `crowded_tickers` store from that answer, stamping a
 * {@link CROWDING_TTL_DAYS}-day expiry on each.
 *
 * Idempotent by construction: a run fully *replaces* the store (delete-all then
 * insert), so running it twice yields the same set with no duplicates — the AC's
 * "manually runnable and idempotent". Tickers are upper-cased and de-duplicated
 * (first evidence wins) before insert.
 */
import { Inject, Injectable, Logger } from "@nestjs/common";
import { schema } from "@magpie/db";
import { DB_CLIENT, type DbClient } from "../infra/infra.module.js";
import { PIPELINE_CLOCK, type Clock } from "../pipeline/pipeline.types.js";
import {
  CROWDING_RESEARCHER,
  CROWDING_TTL_DAYS,
  type CrowdedTickerEvidence,
  type CrowdingResearcher,
} from "./crowding.types.js";

/** Outcome of a refresh run, for the dev endpoint and tests. */
export interface CrowdingRefreshResult {
  tickers: string[];
  expiresAt: string;
}

@Injectable()
export class CrowdingRefreshService {
  private readonly logger = new Logger(CrowdingRefreshService.name);

  constructor(
    @Inject(DB_CLIENT) private readonly dbClient: DbClient,
    @Inject(PIPELINE_CLOCK) private readonly clock: Clock,
    @Inject(CROWDING_RESEARCHER)
    private readonly researcher: CrowdingResearcher,
  ) {}

  async refresh(): Promise<CrowdingRefreshResult> {
    const raw = await this.researcher.research();
    const deduped = dedupeByTicker(raw);

    const now = this.clock.now();
    const expiresAt = new Date(
      now.getTime() + CROWDING_TTL_DAYS * 24 * 60 * 60 * 1000,
    );

    // Full replace → idempotent. Both statements run in one transaction so a
    // failed insert never leaves the store empty.
    await this.dbClient.db.transaction(async (tx) => {
      await tx.delete(schema.crowdedTickers);
      if (deduped.length > 0) {
        await tx.insert(schema.crowdedTickers).values(
          deduped.map((e) => ({
            ticker: e.ticker,
            sourceEvidence: e.evidence,
            expiresAt,
          })),
        );
      }
    });

    const tickers = deduped.map((e) => e.ticker);
    this.logger.log(
      `crowded_tickers refreshed: ${tickers.length} names, expiring ${expiresAt.toISOString()}`,
    );
    return { tickers, expiresAt: expiresAt.toISOString() };
  }
}

/** Upper-case tickers and drop duplicates, keeping the first evidence seen. */
function dedupeByTicker(
  entries: CrowdedTickerEvidence[],
): CrowdedTickerEvidence[] {
  const seen = new Set<string>();
  const out: CrowdedTickerEvidence[] = [];
  for (const e of entries) {
    const ticker = e.ticker.trim().toUpperCase();
    if (ticker.length === 0 || seen.has(ticker)) continue;
    seen.add(ticker);
    out.push({ ticker, evidence: e.evidence });
  }
  return out;
}
