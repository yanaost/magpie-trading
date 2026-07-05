"use client";

import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import type { KillSwitchState } from "@/lib/api";
import {
  getKillSwitch,
  rearmKillSwitch,
  tripKillSwitch,
} from "@/lib/browser-api";

const REARM_PHRASE = "RE-ARM TRADING";

/**
 * Global kill-switch control (spec §5, T1.9). Shows live state, trips with a
 * two-click confirm, and re-arms only when the exact phrase is typed. Polls
 * every 5s so a system trip (daily-loss breach) surfaces without a refresh.
 */
export default function KillSwitch({
  initial,
}: {
  initial: KillSwitchState | null;
}): ReactNode {
  const [state, setState] = useState<KillSwitchState | null>(initial);
  const [confirming, setConfirming] = useState(false);
  const [phrase, setPhrase] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const id = setInterval(() => {
      getKillSwitch()
        .then(setState)
        .catch(() => {});
    }, 5000);
    return () => clearInterval(id);
  }, []);

  async function run(action: () => Promise<KillSwitchState>): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      setState(await action());
      setConfirming(false);
      setPhrase("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const active = state?.active ?? false;

  return (
    <div
      className="panel"
      style={{ borderColor: active ? "var(--down)" : undefined }}
    >
      <div className="row">
        <span className="badge">
          <span className={`dot ${active ? "down" : "up"}`} />
          Kill switch {active ? "ACTIVE — trading halted" : "armed"}
        </span>

        {active ? (
          confirming ? (
            <span className="row" style={{ gap: "0.5rem" }}>
              <input
                aria-label="re-arm confirmation"
                placeholder={REARM_PHRASE}
                value={phrase}
                onChange={(e) => setPhrase(e.target.value)}
                style={{
                  font: "inherit",
                  padding: "0.4rem 0.6rem",
                  background: "var(--bg)",
                  color: "var(--text)",
                  border: "1px solid var(--border)",
                  borderRadius: "6px",
                }}
              />
              <button
                disabled={busy || phrase !== REARM_PHRASE}
                onClick={() => run(() => rearmKillSwitch(phrase))}
              >
                Confirm re-arm
              </button>
              <button disabled={busy} onClick={() => setConfirming(false)}>
                Cancel
              </button>
            </span>
          ) : (
            <button disabled={busy} onClick={() => setConfirming(true)}>
              Re-arm…
            </button>
          )
        ) : confirming ? (
          <span className="row" style={{ gap: "0.5rem" }}>
            <span className="muted">Halt all trading?</span>
            <button
              disabled={busy}
              onClick={() =>
                run(() => tripKillSwitch("Manual trip from dashboard"))
              }
              style={{ borderColor: "var(--down)", color: "var(--down)" }}
            >
              Yes, trip it
            </button>
            <button disabled={busy} onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </span>
        ) : (
          <button
            onClick={() => setConfirming(true)}
            style={{ borderColor: "var(--down)", color: "var(--down)" }}
          >
            Trip kill switch
          </button>
        )}
      </div>

      {state?.reason ? (
        <div className="muted" style={{ marginTop: "0.6rem" }}>
          {active ? "Tripped" : "Last trip"}: {state.reason}
          {state.trippedBy ? ` (by ${state.trippedBy})` : ""}
        </div>
      ) : null}

      {active ? (
        <div className="muted" style={{ marginTop: "0.4rem" }}>
          Re-arming does not restore strategy modes — every strategy stays in
          WATCH until you promote it.
        </div>
      ) : null}

      {error ? (
        <p className="error" style={{ marginTop: "0.5rem" }}>
          {error}
        </p>
      ) : null}
    </div>
  );
}
