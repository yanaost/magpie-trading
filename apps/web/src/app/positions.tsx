"use client";

import type { ReactNode } from "react";
import { useCallback, useEffect, useState } from "react";
import { io, type Socket } from "socket.io-client";
import type { PortfolioSummary, PositionView } from "@/lib/api";
import { BROWSER_API_URL, getPortfolio, getPositions } from "@/lib/browser-api";

/**
 * Live open-positions panel (T1.9) with a portfolio-bar rollup. Refreshes on a
 * 3s poll and immediately when the API pushes over the `positions` WS channel
 * (e.g. right after an approval fills a SIM bracket). Distance-to-stop is the
 * entry-relative move to the stop; unrealized P&L marking lands with T2 (SIM
 * positions aren't marked yet).
 */
export default function Positions({
  initialPositions,
  initialPortfolio,
}: {
  initialPositions: PositionView[];
  initialPortfolio: PortfolioSummary | null;
}): ReactNode {
  const [positions, setPositions] = useState<PositionView[]>(initialPositions);
  const [portfolio, setPortfolio] = useState<PortfolioSummary | null>(
    initialPortfolio,
  );

  const refresh = useCallback(() => {
    getPositions()
      .then(setPositions)
      .catch(() => {});
    getPortfolio()
      .then(setPortfolio)
      .catch(() => {});
  }, []);

  useEffect(() => {
    const poll = setInterval(refresh, 3000);
    const socket: Socket = io(BROWSER_API_URL, { transports: ["websocket"] });
    socket.on("positions", () => refresh());
    return () => {
      clearInterval(poll);
      socket.close();
    };
  }, [refresh]);

  return (
    <div className="panel">
      <div
        className="row"
        style={{ marginBottom: positions.length ? "0.75rem" : 0 }}
      >
        <span className="badge">
          <span className="dot up" />
          {portfolio?.openPositions ?? positions.length} open
        </span>
        <span className="badge">
          Open risk ${(portfolio?.openRiskUsd ?? 0).toLocaleString()}
        </span>
        {portfolio?.tickers.length ? (
          <span className="muted">{portfolio.tickers.join(" · ")}</span>
        ) : null}
      </div>

      {positions.length === 0 ? (
        <p className="muted">No open positions.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Strategy</th>
              <th>Position</th>
              <th>Entry</th>
              <th>Stop</th>
              <th>Dist. to stop</th>
              <th>Risk</th>
            </tr>
          </thead>
          <tbody>
            {positions.map((p, i) => (
              <tr key={`${p.strategyId}:${p.ticker}:${i}`}>
                <td>{p.strategyId}</td>
                <td>
                  {p.side.toUpperCase()} {p.qty} {p.ticker}
                </td>
                <td>{p.avgEntryPrice}</td>
                <td>{p.stopPrice ?? "—"}</td>
                <td>
                  {p.distanceToStopPct === null
                    ? "—"
                    : `${p.distanceToStopPct.toFixed(2)}%`}
                </td>
                <td>${p.openRiskUsd.toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
