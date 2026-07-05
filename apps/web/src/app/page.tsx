import type { ReactNode } from "react";
import { requireAuth } from "@/lib/auth";
import {
  fetchCandleCounts,
  fetchStrategies,
  type CandleCount,
  type StrategySummary,
} from "@/lib/api";
import LiveStatus from "./live-status";

export const dynamic = "force-dynamic";

const WS_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

export default async function Dashboard(): Promise<ReactNode> {
  await requireAuth();

  let strategies: StrategySummary[] = [];
  let counts: CandleCount[] = [];
  let apiError: string | null = null;

  try {
    [strategies, counts] = await Promise.all([
      fetchStrategies(),
      fetchCandleCounts(),
    ]);
  } catch (err) {
    apiError = err instanceof Error ? err.message : String(err);
  }

  return (
    <main>
      <div className="row">
        <div>
          <h1>Magpie Trading Dashboard</h1>
          <p className="muted">Single-user control surface · Phase 0</p>
        </div>
        <form method="post" action="/api/logout">
          <button type="submit">Sign out</button>
        </form>
      </div>

      <h2>System status</h2>
      <LiveStatus apiUrl={WS_URL} />

      {apiError ? (
        <p className="error">Could not reach API: {apiError}</p>
      ) : null}

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

      <h2>Strategies</h2>
      <div className="panel">
        {strategies.length === 0 ? (
          <p className="muted">No strategies configured yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Timeframe</th>
                <th>Mode</th>
                <th>Target</th>
              </tr>
            </thead>
            <tbody>
              {strategies.map((s) => (
                <tr key={s.id}>
                  <td>{s.name}</td>
                  <td>{s.timeframe}</td>
                  <td>{s.mode}</td>
                  <td>{s.target}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </main>
  );
}
