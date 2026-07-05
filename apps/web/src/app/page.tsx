import type { ReactNode } from "react";
import Link from "next/link";
import { requireAuth } from "@/lib/auth";
import {
  fetchCandleCounts,
  fetchKillSwitch,
  fetchPendingProposals,
  fetchPortfolio,
  fetchPositions,
  fetchSignals,
  fetchStrategies,
  type CandleCount,
  type JournalView,
  type KillSwitchState,
  type PortfolioSummary,
  type PositionView,
  type ProposalView,
  type StrategySummary,
} from "@/lib/api";
import LiveStatus from "./live-status";
import KillSwitch from "./kill-switch";
import StrategyControls from "./strategy-controls";
import Approvals from "./approvals";
import Positions from "./positions";
import SignalLog from "./signal-log";

export const dynamic = "force-dynamic";

const WS_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

export default async function Dashboard(): Promise<ReactNode> {
  await requireAuth();

  let strategies: StrategySummary[] = [];
  let counts: CandleCount[] = [];
  let positions: PositionView[] = [];
  let portfolio: PortfolioSummary | null = null;
  let proposals: ProposalView[] = [];
  let signals: JournalView[] = [];
  let killSwitch: KillSwitchState | null = null;
  let apiError: string | null = null;

  try {
    [strategies, counts, positions, portfolio, proposals, signals, killSwitch] =
      await Promise.all([
        fetchStrategies(),
        fetchCandleCounts(),
        fetchPositions(),
        fetchPortfolio(),
        fetchPendingProposals(),
        fetchSignals(),
        fetchKillSwitch(),
      ]);
  } catch (err) {
    apiError = err instanceof Error ? err.message : String(err);
  }

  return (
    <main>
      <div className="row">
        <div>
          <h1>Magpie Trading Dashboard</h1>
          <p className="muted">Single-user control surface · Phase 1</p>
        </div>
        <div className="row" style={{ gap: "0.5rem" }}>
          <Link className="badge" href="/journal">
            Journal →
          </Link>
          <form method="post" action="/api/logout">
            <button type="submit">Sign out</button>
          </form>
        </div>
      </div>

      {apiError ? (
        <p className="error">Could not reach API: {apiError}</p>
      ) : null}

      <h2>Safety</h2>
      <KillSwitch initial={killSwitch} />

      <h2>System status</h2>
      <LiveStatus apiUrl={WS_URL} />

      <h2>Strategies</h2>
      <div className="panel">
        {strategies.length === 0 ? (
          <p className="muted">No strategies configured yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Strategy</th>
                <th>Mode</th>
                <th>Target</th>
                <th>Dev</th>
              </tr>
            </thead>
            <tbody>
              {strategies.map((s) => (
                <StrategyControls key={s.id} strategy={s} />
              ))}
            </tbody>
          </table>
        )}
      </div>

      <h2>Pending approvals</h2>
      <Approvals initial={proposals} />

      <h2>Open positions</h2>
      <Positions initialPositions={positions} initialPortfolio={portfolio} />

      <h2>Signal log</h2>
      <SignalLog initial={signals} />

      <h2>Candle counts</h2>
      <div className="panel">
        {counts.length === 0 ? (
          <p className="muted">No candles ingested yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Ticker</th>
                <th>Timeframe</th>
                <th>Bars</th>
              </tr>
            </thead>
            <tbody>
              {counts.map((c) => (
                <tr key={`${c.ticker}:${c.timeframe}`}>
                  <td>{c.ticker}</td>
                  <td>{c.timeframe}</td>
                  <td>{c.count.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </main>
  );
}
