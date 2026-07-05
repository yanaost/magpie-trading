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
        signalId: analysis.signalId,
        verdict: analysis.verdict,
        // numeric columns round-trip as strings in Drizzle.
        confidence: analysis.confidence.toString(),
        reasoning: analysis.reasoning,
        flaggedRisks: analysis.flaggedRisks,
        rawResponse: analysis.rawResponse,
        latencyMs: analysis.latencyMs,
        model: analysis.model,
      })
      .returning({ id: llmAnalyses.id });
    if (!row) throw new Error("llm_analyses insert returned no row");
    return row;
  }
}
