/**
 * Production {@link CrowdingResearcher}: asks Claude, with the server-side
 * web-search tool, which US equities are currently over-recommended / crowded
 * (heavy fintwit + financial-media hype), and returns each with a one-line
 * evidence summary. Output is constrained to a JSON schema so the nightly job
 * gets structured data, not prose. Any transport error propagates — the caller
 * (the manual/nightly runner) decides whether to keep the previous set.
 *
 * When `ANTHROPIC_API_KEY` is unset the SDK throws at call time; wire the
 * {@link NullCrowdingResearcher} instead for offline/CI runs.
 */
import Anthropic from "@anthropic-ai/sdk";
import { Inject, Injectable } from "@nestjs/common";
import { APP_CONFIG, type AppConfig } from "../config/env.schema.js";
import type {
  CrowdedTickerEvidence,
  CrowdingResearcher,
} from "./crowding.types.js";

const WEB_SEARCH_TOOL = {
  type: "web_search_20260209",
  name: "web_search",
} as const;

// Web-search grounding legitimately takes minutes (several searches + reasoning),
// so give the request generous headroom. Combined with streaming below, this
// avoids the SDK's request-timeout cutting off a real, in-progress research run.
const RESEARCH_TIMEOUT_MS = 300_000;

const SYSTEM_PROMPT = [
  "You track market sentiment for an automated trading system.",
  "Identify US-listed equities that are currently OVER-RECOMMENDED — names with unusually heavy, one-sided bullish attention across financial media, analyst upgrades, and retail/fintwit chatter in roughly the last two weeks.",
  "These are 'crowded longs': the trade everyone is already in. Use the web-search tool to ground every pick in recent, verifiable coverage.",
  "Return at most 15 names. For each, give the ticker and a single concise evidence sentence citing what makes it crowded right now.",
  "If you cannot verify genuine crowding for a name, leave it out. Answer only in the required JSON schema.",
].join(" ");

const OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["crowded"],
  properties: {
    crowded: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["ticker", "evidence"],
        properties: {
          ticker: { type: "string" },
          evidence: { type: "string" },
        },
      },
    },
  },
} as const;

@Injectable()
export class AnthropicCrowdingResearcher implements CrowdingResearcher {
  private readonly model: string;
  private readonly client: Anthropic;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.model = config.ANTHROPIC_MODEL;
    this.client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });
  }

  async research(): Promise<CrowdedTickerEvidence[]> {
    // Stream rather than await a single response: web-search research is a long,
    // multi-round-trip call, and streaming keeps the connection alive so it isn't
    // cut off by request timeouts (SDK guidance for long / tool-using requests).
    const message = await this.client.messages
      .stream(
        {
          model: this.model,
          // Generous output budget: in the server-tool loop this caps *each*
          // assistant turn, so the final turn must fit up to 15 tickers with an
          // evidence sentence each. 2048 truncated that final JSON on thorough
          // runs (empty/partial text → parse failure); 8192 leaves ample room.
          max_tokens: 8192,
          system: SYSTEM_PROMPT,
          messages: [
            {
              role: "user",
              content:
                "List the US equities that are over-recommended / crowded-long right now.",
            },
          ],
          tools: [WEB_SEARCH_TOOL],
          output_config: {
            format: { type: "json_schema", schema: OUTPUT_SCHEMA },
          },
        },
        { timeout: RESEARCH_TIMEOUT_MS },
      )
      .finalMessage();

    if (message.stop_reason === "refusal") {
      throw new Error("model refused the crowding-research request");
    }

    // The schema-constrained answer is the final text block. Take the last
    // non-empty one (interim tool-loop narration, if any, precedes it) and
    // fail loudly on an empty/truncated body rather than throwing a cryptic
    // `JSON.parse` SyntaxError — research() runs before any DB write, so a throw
    // here leaves the previous crowded_tickers set intact.
    const text =
      message.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text.trim())
        .filter((t) => t.length > 0)
        .at(-1) ?? "";
    if (text.length === 0) {
      throw new Error(
        `crowding research returned no answer (stop_reason=${message.stop_reason})`,
      );
    }
    const parsed = JSON.parse(text) as { crowded?: CrowdedTickerEvidence[] };
    return parsed.crowded ?? [];
  }
}

/** Offline/CI researcher — reports nothing crowded. */
@Injectable()
export class NullCrowdingResearcher implements CrowdingResearcher {
  async research(): Promise<CrowdedTickerEvidence[]> {
    return [];
  }
}
