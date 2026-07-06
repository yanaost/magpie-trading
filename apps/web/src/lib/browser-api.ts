/**
 * Browser-side API client. Client components fetch and mutate directly against
 * the API (the server-side helpers in `api.ts` can't run in the browser). The
 * base URL comes from `NEXT_PUBLIC_API_URL`, the same one `LiveStatus` uses for
 * the socket.
 */
import type {
  BacktestRunView,
  JournalView,
  KillSwitchState,
  PerformanceView,
  PortfolioSummary,
  PositionView,
  ProposalView,
  StrategySummary,
} from "./api";

export const BROWSER_API_URL =
  process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BROWSER_API_URL}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    cache: "no-store",
  });
  if (!res.ok) {
    let detail = `${res.status}`;
    try {
      const body = (await res.json()) as { message?: string };
      if (body?.message) detail = body.message;
    } catch {
      /* non-JSON error body */
    }
    throw new Error(detail);
  }
  return (await res.json()) as T;
}

export const getStrategies = (): Promise<StrategySummary[]> =>
  req<StrategySummary[]>("/api/strategies");

export const getPositions = (): Promise<PositionView[]> =>
  req<PositionView[]>("/api/positions");

export const getPortfolio = (): Promise<PortfolioSummary> =>
  req<PortfolioSummary>("/api/portfolio");

export const getSignals = (strategyId?: string): Promise<JournalView[]> =>
  req<JournalView[]>(
    `/api/signals${strategyId ? `?strategyId=${encodeURIComponent(strategyId)}` : ""}`,
  );

export const getPerformance = (strategyId: string): Promise<PerformanceView> =>
  req<PerformanceView>(
    `/api/strategies/${encodeURIComponent(strategyId)}/performance`,
  );

export const getBacktests = (strategyId: string): Promise<BacktestRunView[]> =>
  req<BacktestRunView[]>(
    `/api/strategies/${encodeURIComponent(strategyId)}/backtests`,
  );

export const runBacktests = (
  strategyId: string,
  body: {
    from: string;
    to: string;
    timeframe?: string;
    waits?: number[];
    gappers?: unknown[];
  },
): Promise<BacktestRunView[]> =>
  req<BacktestRunView[]>(
    `/api/strategies/${encodeURIComponent(strategyId)}/backtests`,
    { method: "POST", body: JSON.stringify(body) },
  );

export const getKillSwitch = (): Promise<KillSwitchState> =>
  req<KillSwitchState>("/killswitch");

export async function getPendingProposals(): Promise<ProposalView[]> {
  const { proposals } = await req<{ proposals: ProposalView[] }>("/proposals");
  return proposals;
}

export const setStrategy = (
  id: string,
  change: { mode?: string; target?: string; note?: string },
): Promise<StrategySummary> =>
  req<StrategySummary>(`/api/strategies/${id}`, {
    method: "PATCH",
    body: JSON.stringify(change),
  });

export const triggerSynthetic = (
  strategyId: string,
  opts: { ticker?: string; entry?: number } = {},
): Promise<{ outcome: { kind: string } }> =>
  req<{ outcome: { kind: string } }>(`/dev/trigger/${strategyId}`, {
    method: "POST",
    body: JSON.stringify(opts),
  });

export const approveProposal = (
  id: string,
  qty?: number,
): Promise<{ kind: string }> =>
  req<{ kind: string }>(`/proposals/${id}/approve`, {
    method: "POST",
    body: JSON.stringify(qty === undefined ? {} : { qty }),
  });

export const rejectProposal = (id: string): Promise<{ kind: string }> =>
  req<{ kind: string }>(`/proposals/${id}/reject`, { method: "POST" });

export const tripKillSwitch = (reason: string): Promise<KillSwitchState> =>
  req<KillSwitchState>("/killswitch", {
    method: "POST",
    body: JSON.stringify({ reason }),
  });

export const rearmKillSwitch = (
  confirmation: string,
): Promise<KillSwitchState> =>
  req<KillSwitchState>("/killswitch", {
    method: "DELETE",
    body: JSON.stringify({ confirmation }),
  });
