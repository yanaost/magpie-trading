/**
 * Drizzle-backed persistence for `llm_analyses` (spec §7). Append-only: every
 * analysis — proceed or veto — is recorded with its latency, model and raw
 * response for the audit trail.
 */
import { Inject, Injectable } from "@nestjs/common";
import { schema } from "@magpie/db";
import { DB_CLIENT, type DbClient } from "../infra/infra.module.js";
import type { LlmAnalysisRepository, PersistedAnalysis } from "./llm.types.js";

const { llmAnalyses } = schema;

@Injectable()
export class DrizzleLlmAnalysisRepository implements LlmAnalysisRepository {
  constructor(@Inject(DB_CLIENT) private readonly dbClient: DbClient) {}

  async persist(analysis: PersistedAnalysis): Promise<{ id: string }> {
    const [row] = await this.dbClient.db
      .insert(llmAnalyses)
      .values({
        purpose: analysis.purpose,
        signalId: analysis.signalId,
        strategyId: analysis.strategyId,
        ticker: analysis.ticker,
        verdict: analysis.verdict,
        outcome: analysis.outcome,
        // numeric columns round-trip as strings in Drizzle.
        confidence:
          analysis.confidence === null ? null : analysis.confidence.toString(),
        reasoning: analysis.reasoning,
        flaggedRisks: analysis.flaggedRisks,
        systemPrompt: analysis.systemPrompt,
        userPrompt: analysis.userPrompt,
        params: analysis.params,
        webSearches: analysis.webSearches,
        rawResponse: analysis.rawResponse,
        errorText: analysis.errorText,
        latencyMs: analysis.latencyMs,
        model: analysis.model,
        contextHash: analysis.contextHash ?? null,
      })
      .returning({ id: llmAnalyses.id });
    if (!row) throw new Error("llm_analyses insert returned no row");
    return row;
  }
}
