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

const RESEARCH_TIMEOUT_MS = 60_000;

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
    const message = await this.client.messages.create(
      {
        model: this.model,
        max_tokens: 2048,
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
    );

    if (message.stop_reason === "refusal") {
      throw new Error("model refused the crowding-research request");
    }
    const text = message.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
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
