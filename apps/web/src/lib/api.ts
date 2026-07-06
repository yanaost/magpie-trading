/**
 * Server-side fetch helpers for the trading API. `API_URL` is the server→API
 * base (defaults to the local API); the browser uses `NEXT_PUBLIC_API_URL` for
 * WebSocket connections and its own mutating calls (see `lib/browser-api.ts`).
 */

const API_URL = process.env.API_URL ?? "http://localhost:3001";

export interface StrategySummary {
  id: string;
  name: string;
  timeframe: string;
  mode: string;
  target: string;
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
