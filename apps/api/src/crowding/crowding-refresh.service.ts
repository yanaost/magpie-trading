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
import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { schema } from "@magpie/db";
import { DB_CLIENT, type DbClient } from "../infra/infra.module.js";
import { PIPELINE_CLOCK, type Clock } from "../pipeline/pipeline.types.js";
import {
  LLM_ANALYSIS_REPOSITORY,
  type LlmAnalysisRepository,
} from "../llm/llm.types.js";
import {
  CROWDING_RESEARCHER,
  CROWDING_TTL_DAYS,
  type CrowdedTickerEvidence,
  type CrowdingDialog,
  type CrowdingResearcher,
  type CrowdingResearchResult,
} from "./crowding.types.js";

/** Outcome of a refresh run, for the dev endpoint and tests. */
export interface CrowdingRefreshResult {
  tickers: string[];
  expiresAt: string;
}

/** Strategy id the crowding scan logs its dialog rows under (U1). */
const CROWDING_STRATEGY_ID = "ai-crowding-filter";

@Injectable()
export class CrowdingRefreshService {
  private readonly logger = new Logger(CrowdingRefreshService.name);

  constructor(
    @Inject(DB_CLIENT) private readonly dbClient: DbClient,
    @Inject(PIPELINE_CLOCK) private readonly clock: Clock,
    @Inject(CROWDING_RESEARCHER)
    private readonly researcher: CrowdingResearcher,
    // Optional so unit tests can construct the service without the LLM wiring;
    // when present, each scan's dialog is logged to the shared audit trail (U1).
    @Optional()
    @Inject(LLM_ANALYSIS_REPOSITORY)
    private readonly llmLog: LlmAnalysisRepository | null = null,
  ) {}

  async refresh(): Promise<CrowdingRefreshResult> {
    let result: CrowdingResearchResult;
    try {
      result = await this.researcher.research();
    } catch (err) {
      // Log the failed call as a first-class row before propagating, so the
      // dialog log shows crowding scans that errored out (U1).
      await this.logCrowdingFailure(err);
      throw err;
    }
    await this.logCrowdingDialog(result.dialog);
    const deduped = dedupeByTicker(result.tickers);

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

  /** Record a successful crowding scan's dialog (U1). Fail-inert: never throws. */
  private async logCrowdingDialog(
    dialog: CrowdingDialog | null,
  ): Promise<void> {
    if (!this.llmLog || !dialog) return;
    try {
      await this.llmLog.persist({
        purpose: "crowding_scan",
        signalId: null,
        strategyId: CROWDING_STRATEGY_ID,
        ticker: null,
        verdict: null,
        outcome: "proceed",
        confidence: null,
        reasoning: null,
        flaggedRisks: [],
        systemPrompt: dialog.systemPrompt,
        userPrompt: dialog.userPrompt,
        params: dialog.params,
        webSearches: dialog.webSearches,
        rawResponse: dialog.rawResponse,
        errorText: null,
        latencyMs: null,
        model: dialog.model,
      });
    } catch (err) {
      this.logger.error(`failed to log crowding dialog: ${describeError(err)}`);
    }
  }

  /** Record a failed crowding scan as a `veto_by_failure` row (U1). Fail-inert. */
  private async logCrowdingFailure(err: unknown): Promise<void> {
    if (!this.llmLog) return;
    // Reconstruct the request side so the log shows what was asked, even though
    // the call itself never returned.
    const req = this.researcher.describeCall();
    try {
      await this.llmLog.persist({
        purpose: "crowding_scan",
        signalId: null,
        strategyId: CROWDING_STRATEGY_ID,
        ticker: null,
        verdict: null,
        outcome: "veto_by_failure",
        confidence: null,
        reasoning: null,
        flaggedRisks: [],
        systemPrompt: req.systemPrompt,
        userPrompt: req.userPrompt,
        params: req.params,
        webSearches: null,
        rawResponse: null,
        errorText: describeError(err),
        latencyMs: null,
        model: req.model,
      });
    } catch (logErr) {
      this.logger.error(
        `failed to log crowding failure: ${describeError(logErr)}`,
      );
    }
  }
}

/** Turn any thrown value into a short, audit-friendly message. */
function describeError(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
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
