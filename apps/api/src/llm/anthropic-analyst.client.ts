/**
 * Production transport for the LLM analyst: wraps the Anthropic SDK.
 *
 * It calls Claude with the strategy's prompt, optionally enabling the
 * server-side web-search tool, and constrains the answer to the analyst JSON
 * schema via `output_config.format`. It returns the raw parsed candidate and
 * text; it never decides proceed/veto — that trust boundary lives in the
 * service (`parseLlmAnalysis`). Any transport failure is thrown, not swallowed.
 */
import Anthropic from "@anthropic-ai/sdk";
import { Inject, Injectable } from "@nestjs/common";
import type { AnalysisRequest } from "@magpie/core";
import { APP_CONFIG, type AppConfig } from "../config/env.schema.js";
import { LLM_OUTPUT_JSON_SCHEMA } from "./llm-output.schema.js";
import {
  LLM_ANALYSIS_TIMEOUT_MS,
  type LlmCallDescription,
  type LlmAnalystClient,
  type LlmRawResult,
  type WebSearchInvocation,
} from "./llm.types.js";

/** Web-search tool version paired with current Sonnet/Opus models (skill: API drift). */
const WEB_SEARCH_TOOL = {
  type: "web_search_20260209",
  name: "web_search",
} as const;

const SYSTEM_PROMPT = [
  "You are a risk analyst for an automated day-trading system.",
  "A quant strategy has already fired a signal; your only job is to VERIFY the qualitative thesis and surface disqualifying risks.",
  "You never see or set position sizes, prices, or order parameters — the risk manager owns all numbers.",
  "Your entire authority is a single binary verdict: 'proceed' or 'veto'.",
  "Veto whenever you are uncertain, cannot verify a material claim, or find a disqualifying risk (pending earnings, halts, litigation, M&A, index rebalances, etc.).",
  "Use the web-search tool when it is available and the thesis depends on current facts.",
  "Answer only in the required JSON schema.",
].join(" ");

/** Build the user-turn text from the structured request (no sizes/prices). */
function renderRequest(request: AnalysisRequest): string {
  const parts = [`Ticker: ${request.ticker}`, "", request.prompt];
  if (request.requiredChecks.length > 0) {
    parts.push("", "Address each of these checks explicitly:");
    for (const check of request.requiredChecks) parts.push(`- ${check}`);
  }
  if (Object.keys(request.context).length > 0) {
    parts.push("", "Context:", JSON.stringify(request.context, null, 2));
  }
  return parts.join("\n");
}

/** Concatenate the text blocks of a message into one string. */
function extractText(content: Anthropic.ContentBlock[]): string {
  return content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
}

/** A server_tool_use block for the web-search tool, narrowed for extraction. */
interface ServerToolUseBlock {
  type: "server_tool_use";
  name: string;
  input?: { query?: unknown };
}

/**
 * Pull the web-search queries the model issued from the response blocks, for the
 * dialog log. Returns null when the model made no searches (or the SDK exposed
 * none) so the audit clearly distinguishes "no search" from "not captured".
 */
function extractWebSearches(
  content: Anthropic.ContentBlock[],
): WebSearchInvocation[] | null {
  const searches: WebSearchInvocation[] = [];
  for (const block of content as Array<{ type: string }>) {
    if (block.type !== "server_tool_use") continue;
    const tool = block as ServerToolUseBlock;
    if (tool.name !== "web_search") continue;
    const query = tool.input?.query;
    if (typeof query === "string" && query.length > 0) searches.push({ query });
  }
  return searches.length > 0 ? searches : null;
}

@Injectable()
export class AnthropicAnalystClient implements LlmAnalystClient {
  readonly model: string;
  private readonly client: Anthropic;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.model = config.ANTHROPIC_MODEL;
    // apiKey may be undefined here; the SDK reads ANTHROPIC_API_KEY from env and
    // throws at call time if truly absent. The service turns that into a veto.
    this.client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });
  }

  /** The max output tokens for one analysis call — surfaced in the dialog log. */
  private static readonly MAX_TOKENS = 1024;

  describeCall(request: AnalysisRequest): LlmCallDescription {
    return {
      systemPrompt: SYSTEM_PROMPT,
      userPrompt: renderRequest(request),
      params: {
        model: this.model,
        maxTokens: AnthropicAnalystClient.MAX_TOKENS,
        webSearch: request.webSearch,
        tools: request.webSearch ? [WEB_SEARCH_TOOL.name] : [],
      },
    };
  }

  async analyze(
    request: AnalysisRequest,
    signal: AbortSignal,
  ): Promise<LlmRawResult> {
    const message = await this.client.messages.create(
      {
        model: this.model,
        max_tokens: AnthropicAnalystClient.MAX_TOKENS,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: renderRequest(request) }],
        ...(request.webSearch ? { tools: [WEB_SEARCH_TOOL] } : {}),
        output_config: {
          format: { type: "json_schema", schema: LLM_OUTPUT_JSON_SCHEMA },
        },
      },
      { signal, timeout: LLM_ANALYSIS_TIMEOUT_MS },
    );

    const raw = extractText(message.content);
    if (message.stop_reason === "refusal") {
      throw new Error("model refused the request");
    }
    // JSON.parse can throw on truncated/empty output; the service vetoes on it.
    const candidate: unknown = JSON.parse(raw);
    return {
      candidate,
      raw,
      model: this.model,
      webSearches: extractWebSearches(message.content),
    };
  }
}
