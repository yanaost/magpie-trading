/**
 * Manual live smoke test for the LLM analyst (T1.5 AC — NOT run in CI).
 *
 * Hits the real Anthropic API with a sample signal and prints the verdict. It
 * needs ANTHROPIC_API_KEY in the environment (and optionally ANTHROPIC_MODEL).
 *
 *   pnpm --filter @magpie/api smoke:llm
 *   # or: npx tsx src/llm/smoke.ts
 */
import "dotenv/config";
import type { AnalysisRequest } from "@magpie/core";
import { loadConfig } from "../config/env.schema.js";
import { AnthropicAnalystClient } from "./anthropic-analyst.client.js";
import { LlmAnalystService } from "./llm-analyst.service.js";
import type { LlmAnalysisRepository, PersistedAnalysis } from "./llm.types.js";

class ConsoleRepo implements LlmAnalysisRepository {
  async persist(analysis: PersistedAnalysis): Promise<{ id: string }> {
    console.log("\n[would persist to llm_analyses]", {
      verdict: analysis.verdict,
      confidence: analysis.confidence,
      latencyMs: analysis.latencyMs,
      model: analysis.model,
    });
    return { id: "smoke" };
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  if (!config.ANTHROPIC_API_KEY) {
    console.error("ANTHROPIC_API_KEY is required for the live smoke test.");
    process.exit(1);
  }

  const client = new AnthropicAnalystClient(config);
  const service = new LlmAnalystService(client, new ConsoleRepo());

  const request: AnalysisRequest = {
    strategyId: "qual-sphb",
    ticker: "QUAL",
    // No signalId → persistence is skipped, which is fine for a smoke test.
    prompt:
      "A quant model flags a risk-on rotation favoring high-quality large caps (QUAL). " +
      "Verify there is no imminent macro or single-name catalyst that would invalidate holding QUAL for a multi-day swing.",
    context: { note: "smoke test" },
    requiredChecks: [
      "No major macro event (FOMC/CPI) in the next 2 trading days",
      "No QUAL index reconstitution scheduled imminently",
    ],
    webSearch: true,
  };

  console.log(`Analyzing with model=${client.model} …`);
  const analysis = await service.analyze(request);
  console.log("\n=== Verdict ===");
  console.log(JSON.stringify(analysis, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
