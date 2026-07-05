/**
 * The JSON schema the model is constrained to when answering (spec §4.2). It
 * mirrors the trusted `LLMAnalysisSchema` in `@magpie/core` but is the wire
 * shape sent to Claude via `output_config.format`, so structured outputs
 * guarantee the response parses. The core schema is still applied afterward —
 * this is the request-side constraint, `parseLlmAnalysis` is the trust boundary.
 */

/** JSON-schema (draft) object passed to `output_config.format.schema`. */
export const LLM_OUTPUT_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "confidence", "reasoning", "flaggedRisks"],
  properties: {
    verdict: {
      type: "string",
      enum: ["proceed", "veto"],
      description:
        "proceed only if the thesis holds and no disqualifying risk is found; otherwise veto. When uncertain, veto.",
    },
    confidence: {
      type: "number",
      minimum: 0,
      maximum: 1,
      description: "Your confidence in the verdict, from 0 to 1.",
    },
    reasoning: {
      type: "string",
      description:
        "A concise justification a human trader can audit. Reference anything you verified via web search.",
    },
    flaggedRisks: {
      type: "array",
      items: { type: "string" },
      description:
        "Named risks you found (e.g. 'earnings in 2 days', 'SEC probe'). Empty if none.",
    },
  },
} as const;
