/**
 * Drizzle-backed {@link AnalysisCache} (T3.1). Looks up a previously-recorded
 * analysis by the request's content hash so replay reuses the model's real
 * verdict instead of stubbing. Returns the most-recent matching row, or `null`
 * when the context was never analysed (→ the engine stubs).
 *
 * Only rows written after the `context_hash` column landed can be found; older
 * analyses simply miss and stub, which is safe (the verdict is flagged).
 */
import { Inject, Injectable } from "@nestjs/common";
import { schema, desc, eq } from "@magpie/db";
import type { LLMAnalysis } from "@magpie/core";
import { DB_CLIENT, type DbClient } from "../infra/infra.module.js";
import type { AnalysisCache } from "./replay-analyst.js";

const { llmAnalyses } = schema;

@Injectable()
export class DrizzleAnalysisCache implements AnalysisCache {
  constructor(@Inject(DB_CLIENT) private readonly dbClient: DbClient) {}

  async lookup(contextHash: string): Promise<LLMAnalysis | null> {
    const [row] = await this.dbClient.db
      .select()
      .from(llmAnalyses)
      .where(eq(llmAnalyses.contextHash, contextHash))
      .orderBy(desc(llmAnalyses.createdAt))
      .limit(1);
    if (!row) return null;
    return {
      verdict: row.verdict,
      confidence: row.confidence === null ? 0 : Number(row.confidence),
      reasoning: row.reasoning ?? "",
      flaggedRisks: row.flaggedRisks,
      model: row.model,
      latencyMs: row.latencyMs ?? undefined,
      raw: row.rawResponse ?? undefined,
    };
  }
}
