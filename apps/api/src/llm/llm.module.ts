/**
 * Wires the LLM analyst to its production collaborators: the Anthropic-backed
 * transport and the Drizzle-backed audit repository. Exports the service so the
 * signal pipeline (T1.6) can inject it.
 */
import { Module } from "@nestjs/common";
import { AnthropicAnalystClient } from "./anthropic-analyst.client.js";
import { DrizzleLlmAnalysisRepository } from "./llm-analysis.repository.js";
import { LlmAnalystService } from "./llm-analyst.service.js";
import { LLM_ANALYSIS_REPOSITORY, LLM_ANALYST_CLIENT } from "./llm.types.js";

@Module({
  providers: [
    LlmAnalystService,
    { provide: LLM_ANALYST_CLIENT, useClass: AnthropicAnalystClient },
    {
      provide: LLM_ANALYSIS_REPOSITORY,
      useClass: DrizzleLlmAnalysisRepository,
    },
  ],
  // Export the analysis repository too so the crowding scan (T2.4, wired in
  // PipelineModule) can log its own dialog rows to the same audit trail (U1).
  exports: [LlmAnalystService, LLM_ANALYSIS_REPOSITORY],
})
export class LlmModule {}
