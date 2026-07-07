"use client";

import type { ReactNode } from "react";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { io, type Socket } from "socket.io-client";
import type { ProposalView } from "@/lib/api";
import {
  BROWSER_API_URL,
  approveProposal,
  getPendingProposals,
  rejectProposal,
} from "@/lib/browser-api";

/**
 * Pending-approvals panel (T1.8/T1.9). Lists proposals awaiting a decision and
 * approves/rejects them. Refreshes on a 3s poll and immediately when the API
 * pushes a new proposal over the `proposals` WS channel.
 */
export default function Approvals({
  initial,
}: {
  initial: ProposalView[];
}): ReactNode {
  const [proposals, setProposals] = useState<ProposalView[]>(initial);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    getPendingProposals()
      .then(setProposals)
      .catch((err) =>
        setError(err instanceof Error ? err.message : String(err)),
      );
  }, []);

  useEffect(() => {
    const poll = setInterval(refresh, 3000);
    const socket: Socket = io(BROWSER_API_URL, { transports: ["websocket"] });
    socket.on("proposals", () => refresh());
    return () => {
      clearInterval(poll);
      socket.close();
    };
  }, [refresh]);

  async function decide(
    id: string,
    action: (id: string) => Promise<unknown>,
  ): Promise<void> {
    setBusy(id);
    setError(null);
    try {
      await action(id);
      // Optimistically drop it; the next poll reconciles.
      setProposals((prev) => prev.filter((p) => p.id !== id));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      refresh();
    } finally {
      setBusy(null);
    }
  }

  if (proposals.length === 0) {
    return (
      <div className="panel">
        <p className="muted">No proposals awaiting approval.</p>
      </div>
    );
  }

  return (
    <div className="panel">
      <table>
        <thead>
          <tr>
            <th>Strategy</th>
            <th>Order</th>
            <th>Stop</th>
            <th>Risk</th>
            <th>Expires</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {proposals.map((p) => (
            <tr key={p.id}>
              <td>{p.strategyId}</td>
              <td>
                {p.side.toUpperCase()} {p.qty} {p.ticker} @ {p.entry}
                <span className="muted"> · {p.executionTarget}</span>
                {p.signalId ? (
                  <div style={{ marginTop: "0.25rem" }}>
                    <Link
                      className="badge"
                      href={`/llm-log?signalId=${encodeURIComponent(p.signalId)}`}
                    >
                      LLM dialog →
                    </Link>
                  </div>
                ) : null}
              </td>
              <td>{p.stop}</td>
              <td>
                ${p.riskUsd.toFixed(0)}{" "}
                <span className="muted">({p.riskPct.toFixed(2)}%)</span>
              </td>
              <td className="muted">
                {new Date(p.expiry).toLocaleTimeString()}
              </td>
              <td style={{ whiteSpace: "nowrap" }}>
                <button
                  disabled={busy === p.id}
                  onClick={() => decide(p.id, (id) => approveProposal(id))}
                  style={{
                    borderColor: "var(--up)",
                    color: "var(--up)",
                    marginRight: "0.4rem",
                  }}
                >
                  Approve
                </button>
                <button
                  disabled={busy === p.id}
                  onClick={() => decide(p.id, rejectProposal)}
                  style={{ borderColor: "var(--down)", color: "var(--down)" }}
                >
                  Reject
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {error ? (
        <p className="error" style={{ marginTop: "0.5rem" }}>
          {error}
        </p>
      ) : null}
    </div>
  );
}
