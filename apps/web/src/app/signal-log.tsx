"use client";

import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import type { JournalView } from "@/lib/api";
import { getSignals } from "@/lib/browser-api";

/**
 * The decision/signal log (T1.9): LLM verdicts, risk rejections, WATCH
 * would-trades, approvals, and exits — newest first, with veto reasons in the
 * body. Polls every 4s so a fresh decision surfaces during the demo.
 */
export default function SignalLog({
  initial,
}: {
  initial: JournalView[];
}): ReactNode {
  const [rows, setRows] = useState<JournalView[]>(initial);

  useEffect(() => {
    const id = setInterval(() => {
      getSignals()
        .then(setRows)
        .catch(() => {});
    }, 4000);
    return () => clearInterval(id);
  }, []);

  if (rows.length === 0) {
    return (
      <div className="panel">
        <p className="muted">No decisions logged yet.</p>
      </div>
    );
  }

  return (
    <div className="panel">
      <table>
        <thead>
          <tr>
            <th>Time</th>
            <th>Strategy</th>
            <th>Decision</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td className="muted" style={{ whiteSpace: "nowrap" }}>
                {new Date(r.createdAt).toLocaleTimeString()}
              </td>
              <td>{r.strategyId ?? "—"}</td>
              <td>
                <strong>{r.title}</strong>
                {r.body ? (
                  <div className="muted" style={{ fontSize: "0.8rem" }}>
                    {r.body}
                  </div>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
