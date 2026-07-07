/**
 * Read-only queries backing the LLM dialog log (U1). Lists persisted
 * `llm_analyses` rows — every per-signal analysis and crowding scan, including
 * failed calls — filtered and paginated for the dashboard, plus a by-id detail
 * that returns the full captured dialog (prompts, params, web searches, raw
 * response, verdict, and any error). Purely presentational: it never mutates the
 * money path and reads only the audit table.
 */
import { Inject, Injectable } from "@nestjs/common";
import { schema, and, desc, eq, gte, lte, sql } from "@magpie/db";
import { DB_CLIENT, type DbClient } from "../infra/infra.module.js";

const { llmAnalyses } = schema;

/** Filters accepted by {@link LlmLogService.list}. All optional. */
export interface LlmLogFilter {
  /** Restrict to the analyses for one signal (used by dashboard cross-links). */
  signalId?: string;
  strategyId?: string;
  ticker?: string;
  purpose?: "signal_analysis" | "crowding_scan";
  verdict?: "proceed" | "veto";
  outcome?: "proceed" | "veto" | "veto_by_failure";
  /** Inclusive lower bound on `createdAt`. */
  from?: Date;
  /** Inclusive upper bound on `createdAt`. */
  to?: Date;
  /** Page size (defaults + clamping applied by the controller). */
  limit: number;
  /** Row offset for pagination. */
  offset: number;
}

/** A compact row for the log table (no heavy prompt/raw payloads). */
export interface LlmLogListItem {
  id: string;
  purpose: string;
  signalId: string | null;
  strategyId: string | null;
  ticker: string | null;
  verdict: string | null;
  outcome: string | null;
  confidence: number | null;
  latencyMs: number | null;
  model: string;
  /** Number of web searches the model made (null if none captured). */
  webSearchCount: number | null;
  /** Truncated error text for failed calls, for an at-a-glance table cell. */
  errorText: string | null;
  createdAt: string;
}

/** A paginated page of log rows plus the total matching count. */
export interface LlmLogPage {
  items: LlmLogListItem[];
  total: number;
  limit: number;
  offset: number;
}

/** The full captured dialog for one row (U1 detail view). */
export interface LlmLogDetail extends LlmLogListItem {
  reasoning: string | null;
  flaggedRisks: string[];
  systemPrompt: string | null;
  userPrompt: string | null;
  params: Record<string, unknown> | null;
  webSearches: { query: string }[] | null;
  rawResponse: string | null;
  contextHash: string | null;
}

@Injectable()
export class LlmLogService {
  constructor(@Inject(DB_CLIENT) private readonly dbClient: DbClient) {}

  /** A page of log rows matching `filter`, newest-first, with the total count. */
  async list(filter: LlmLogFilter): Promise<LlmLogPage> {
    const where = buildWhere(filter);

    const rows = await this.dbClient.db
      .select({
        id: llmAnalyses.id,
        purpose: llmAnalyses.purpose,
        signalId: llmAnalyses.signalId,
        strategyId: llmAnalyses.strategyId,
        ticker: llmAnalyses.ticker,
        verdict: llmAnalyses.verdict,
        outcome: llmAnalyses.outcome,
        confidence: llmAnalyses.confidence,
        latencyMs: llmAnalyses.latencyMs,
        model: llmAnalyses.model,
        webSearches: llmAnalyses.webSearches,
        errorText: llmAnalyses.errorText,
        createdAt: llmAnalyses.createdAt,
      })
      .from(llmAnalyses)
      .where(where)
      .orderBy(desc(llmAnalyses.createdAt))
      .limit(filter.limit)
      .offset(filter.offset);

    const [countRow] = await this.dbClient.db
      .select({ count: sql<number>`count(*)::int` })
      .from(llmAnalyses)
      .where(where);
    const count = countRow?.count ?? 0;

    return {
      items: rows.map((r) => ({
        id: r.id,
        purpose: r.purpose,
        signalId: r.signalId,
        strategyId: r.strategyId,
        ticker: r.ticker,
        verdict: r.verdict,
        outcome: r.outcome,
        confidence: r.confidence === null ? null : Number(r.confidence),
        latencyMs: r.latencyMs,
        model: r.model,
        webSearchCount: r.webSearches?.length ?? null,
        errorText: truncate(r.errorText, 200),
        createdAt: r.createdAt.toISOString(),
      })),
      total: count,
      limit: filter.limit,
      offset: filter.offset,
    };
  }

  /** The full dialog for one row, or null if the id is unknown. */
  async detail(id: string): Promise<LlmLogDetail | null> {
    const [r] = await this.dbClient.db
      .select()
      .from(llmAnalyses)
      .where(eq(llmAnalyses.id, id))
      .limit(1);
    if (!r) return null;

    return {
      id: r.id,
      purpose: r.purpose,
      signalId: r.signalId,
      strategyId: r.strategyId,
      ticker: r.ticker,
      verdict: r.verdict,
      outcome: r.outcome,
      confidence: r.confidence === null ? null : Number(r.confidence),
      latencyMs: r.latencyMs,
      model: r.model,
      webSearchCount: r.webSearches?.length ?? null,
      errorText: r.errorText,
      createdAt: r.createdAt.toISOString(),
      reasoning: r.reasoning,
      flaggedRisks: r.flaggedRisks,
      systemPrompt: r.systemPrompt,
      userPrompt: r.userPrompt,
      params: r.params,
      webSearches: r.webSearches,
      rawResponse: r.rawResponse,
      contextHash: r.contextHash,
    };
  }
}

/** Build the combined WHERE from the active filters (undefined = no filter). */
function buildWhere(filter: LlmLogFilter) {
  const conditions = [];
  if (filter.signalId)
    conditions.push(eq(llmAnalyses.signalId, filter.signalId));
  if (filter.strategyId)
    conditions.push(eq(llmAnalyses.strategyId, filter.strategyId));
  if (filter.ticker) conditions.push(eq(llmAnalyses.ticker, filter.ticker));
  if (filter.purpose) conditions.push(eq(llmAnalyses.purpose, filter.purpose));
  if (filter.verdict) conditions.push(eq(llmAnalyses.verdict, filter.verdict));
  if (filter.outcome) conditions.push(eq(llmAnalyses.outcome, filter.outcome));
  if (filter.from) conditions.push(gte(llmAnalyses.createdAt, filter.from));
  if (filter.to) conditions.push(lte(llmAnalyses.createdAt, filter.to));
  if (conditions.length === 0) return undefined;
  if (conditions.length === 1) return conditions[0];
  return and(...conditions);
}

/** Shorten long error text for the compact list cell. */
function truncate(text: string | null, max: number): string | null {
  if (text === null) return null;
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}
