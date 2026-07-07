/**
 * Server-side fetch helpers for the trading API. `API_URL` is the server→API
 * base (defaults to the local API); the browser uses `NEXT_PUBLIC_API_URL` for
 * WebSocket connections and its own mutating calls (see `lib/browser-api.ts`).
 */

const API_URL = process.env.API_URL ?? "http://localhost:3001";

/** Plain-language mechanics for a strategy (spec §U2). */
export interface StrategyMechanic {
  trigger: string[];
  exitPlan: string[];
  llmRole: string;
  dataNeeds: string;
}

/** The "About this strategy" content served with each strategy. */
export interface StrategyMeta {
  summary: string;
  mechanic: StrategyMechanic;
  dataReady: boolean;
}

export interface StrategySummary {
  id: string;
  name: string;
  timeframe: string;
  mode: string;
  target: string;
  meta: StrategyMeta | null;
  /** APPROVE proposal time-to-live in ms, from config (spec §U4). */
  proposalTtlMs: number;
  /** AUTO daily trade cap, shown in the switch-to-AUTO confirm (spec §U4). */
  autoMaxTradesPerDay: number;
}

export interface CandleCount {
  ticker: string;
  timeframe: string;
  count: number;
}

export interface PositionView {
  strategyId: string;
  ticker: string;
  side: string;
  qty: number;
  avgEntryPrice: number;
  stopPrice: number | null;
  distanceToStopPct: number | null;
  openRiskUsd: number;
  openedAt: string;
}

export interface PortfolioSummary {
  openPositions: number;
  openRiskUsd: number;
  tickers: string[];
}

export interface ProposalView {
  id: string;
  strategyId: string;
  /** The signal/LLM-dialog id that produced this proposal, if any (U1). */
  signalId: string | null;
  ticker: string;
  side: string;
  qty: number;
  entry: number;
  stop: number;
  target: number | null;
  riskUsd: number;
  riskPct: number;
  status: string;
  executionTarget: string;
  expiry: string;
}

export interface JournalView {
  id: string;
  strategyId: string | null;
  entryType: string;
  refType: string | null;
  refId: string | null;
  title: string;
  body: string | null;
  meta: Record<string, unknown> | null;
  createdAt: string;
}

export interface EquityPoint {
  t: string;
  equity: number;
}

export interface PerformanceStats {
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  avgR: number;
  totalPnl: number;
  maxDrawdown: number;
  equityCurve: EquityPoint[];
}

export interface PerformanceView {
  strategyId: string;
  byTarget: Record<string, PerformanceStats>;
}

export interface VetoStats {
  signals: number;
  executed: number;
  proposed: number;
  watched: number;
  vetoedByLlm: number;
  vetoedByCrowding: number;
  riskRejected: number;
  autoCapped: number;
}

export interface StubbingCaveat {
  analyses: number;
  stubbed: number;
  stubbedFraction: number;
}

export interface BacktestReport {
  performance: PerformanceStats;
  vetoStats: VetoStats;
  stubbing: StubbingCaveat;
  replayStubbed: boolean;
}

/** A persisted variant backtest run (T3.5). */
export interface BacktestRunView {
  id: string;
  strategyId: string;
  instanceId: string;
  label: string;
  params: Record<string, unknown>;
  from: string;
  to: string;
  bars: number;
  report: BacktestReport;
  replayStubbed: boolean;
  createdAt: string;
}

/** A compact LLM dialog-log row for the table (U1). */
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
  webSearchCount: number | null;
  errorText: string | null;
  createdAt: string;
}

/** A page of dialog-log rows with the total matching count (U1). */
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

/** Filters for the dialog-log list (all optional). */
export interface LlmLogQuery {
  signalId?: string;
  strategyId?: string;
  ticker?: string;
  purpose?: string;
  verdict?: string;
  outcome?: string;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

export interface KillSwitchState {
  active: boolean;
  reason: string | null;
  trippedBy: string | null;
  trippedAt: string | null;
  rearmedAt: string | null;
}

async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, { cache: "no-store" });
  if (!res.ok) {
    throw new Error(`API ${path} -> ${res.status}`);
  }
  return (await res.json()) as T;
}

export function fetchStrategies(): Promise<StrategySummary[]> {
  return apiGet<StrategySummary[]>("/api/strategies");
}

export function fetchCandleCounts(): Promise<CandleCount[]> {
  return apiGet<CandleCount[]>("/api/candles/counts");
}

export function fetchPositions(strategyId?: string): Promise<PositionView[]> {
  const q = strategyId ? `?strategyId=${encodeURIComponent(strategyId)}` : "";
  return apiGet<PositionView[]>(`/api/positions${q}`);
}

export function fetchPerformance(strategyId: string): Promise<PerformanceView> {
  return apiGet<PerformanceView>(
    `/api/strategies/${encodeURIComponent(strategyId)}/performance`,
  );
}

export function fetchBacktests(strategyId: string): Promise<BacktestRunView[]> {
  return apiGet<BacktestRunView[]>(
    `/api/strategies/${encodeURIComponent(strategyId)}/backtests`,
  );
}

export function fetchPortfolio(): Promise<PortfolioSummary> {
  return apiGet<PortfolioSummary>("/api/portfolio");
}

export function fetchSignals(): Promise<JournalView[]> {
  return apiGet<JournalView[]>("/api/signals");
}

export function fetchJournal(): Promise<JournalView[]> {
  return apiGet<JournalView[]>("/api/journal");
}

export async function fetchPendingProposals(): Promise<ProposalView[]> {
  const { proposals } = await apiGet<{ proposals: ProposalView[] }>(
    "/proposals",
  );
  return proposals;
}

export function fetchKillSwitch(): Promise<KillSwitchState> {
  return apiGet<KillSwitchState>("/killswitch");
}

/** A page of LLM dialog-log rows, filtered/paginated (U1). */
export function fetchLlmLogs(query: LlmLogQuery = {}): Promise<LlmLogPage> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== "") params.set(key, String(value));
  }
  const qs = params.toString();
  return apiGet<LlmLogPage>(`/llm-logs${qs ? `?${qs}` : ""}`);
}

/** The full captured dialog for one log row (U1). */
export function fetchLlmLog(id: string): Promise<LlmLogDetail> {
  return apiGet<LlmLogDetail>(`/llm-logs/${encodeURIComponent(id)}`);
}
