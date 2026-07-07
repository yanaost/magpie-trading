"use client";

import type { CSSProperties, ReactNode } from "react";
import { useEffect, useState } from "react";
import type { StrategySummary } from "@/lib/api";
import { setStrategy, triggerSynthetic } from "@/lib/browser-api";

const MODES = ["AUTO", "APPROVE", "WATCH", "OFF"];
const TARGETS = ["SIM", "PAPER", "LIVE"];
const RUNG: Record<string, number> = { SIM: 0, PAPER: 1, LIVE: 2 };

/** True when moving to `to` is a promotion (a higher-risk rung) from `from`. */
function isPromotion(from: string, to: string): boolean {
  return (RUNG[to] ?? 0) > (RUNG[from] ?? 0);
}

function badgeTone(mode: string): string {
  if (mode === "AUTO") return "var(--up)";
  if (mode === "APPROVE") return "var(--degraded)";
  return "var(--muted)";
}

/**
 * Per-strategy control row (T1.9): live mode/target selectors that PATCH the
 * strategy (taking effect on the next scan without a redeploy) plus a dev-only
 * "Trigger" button that injects a synthetic signal for the full-loop demo.
 */
export default function StrategyControls({
  strategy,
  onChanged,
}: {
  strategy: StrategySummary;
  onChanged?: (updated: StrategySummary) => void;
}): ReactNode {
  const [mode, setMode] = useState(strategy.mode);
  const [target, setTarget] = useState(strategy.target);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Re-sync from the server whenever the roster prop refreshes (the parent polls
  // the API). Without this the badge freezes on its first-render value and shows
  // a stale mode after a change made elsewhere — dangerous on a trading panel.
  // A local edit sets these optimistically and the next poll returns the same
  // value, so there's no flicker.
  useEffect(() => {
    setMode(strategy.mode);
  }, [strategy.mode]);
  useEffect(() => {
    setTarget(strategy.target);
  }, [strategy.target]);

  async function change(patch: {
    mode?: string;
    target?: string;
    note?: string;
  }): Promise<void> {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const updated = await setStrategy(strategy.id, patch);
      setMode(updated.mode);
      setTarget(updated.target);
      // Lift the change to the parent roster immediately so switching tabs
      // (or the panel remounting) reflects the new value instead of the stale
      // SSR snapshot until the next 10s poll.
      onChanged?.(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  /**
   * Promoting the execution rung (e.g. SIM→PAPER) requires an attached review
   * note (T2.2); prompt for one before sending. Demotions skip the prompt.
   */
  function changeTarget(next: string): void {
    if (isPromotion(target, next)) {
      const reason = window.prompt(
        `Promote ${strategy.name} from ${target} to ${next}.\nAttach a review note (required):`,
      );
      if (reason === null || reason.trim().length === 0) {
        setError("Promotion cancelled — a review note is required.");
        return;
      }
      void change({ target: next, note: reason.trim() });
      return;
    }
    void change({ target: next });
  }

  async function trigger(): Promise<void> {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const { outcome } = await triggerSynthetic(strategy.id);
      setNote(`Signal injected → ${outcome.kind}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <tr>
      <td>
        <strong>{strategy.name}</strong>
        <div className="muted" style={{ fontSize: "0.8rem" }}>
          {strategy.timeframe}
        </div>
      </td>
      <td>
        <span
          className="badge"
          style={{ borderColor: badgeTone(mode), marginRight: "0.5rem" }}
        >
          <span className="dot" style={{ background: badgeTone(mode) }} />
          {mode}
        </span>
        <select
          aria-label={`${strategy.name} mode`}
          value={mode}
          disabled={busy}
          onChange={(e) => change({ mode: e.target.value })}
          style={selectStyle}
        >
          {MODES.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
      </td>
      <td>
        <select
          aria-label={`${strategy.name} target`}
          value={target}
          disabled={busy}
          onChange={(e) => changeTarget(e.target.value)}
          style={selectStyle}
        >
          {TARGETS.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </td>
      <td>
        <button disabled={busy} onClick={trigger}>
          Trigger signal
        </button>
        {note ? (
          <div
            className="muted"
            style={{ fontSize: "0.8rem", marginTop: "0.3rem" }}
          >
            {note}
          </div>
        ) : null}
        {error ? (
          <div className="error" style={{ marginTop: "0.3rem" }}>
            {error}
          </div>
        ) : null}
      </td>
    </tr>
  );
}

const selectStyle: CSSProperties = {
  font: "inherit",
  padding: "0.35rem 0.5rem",
  background: "var(--bg)",
  color: "var(--text)",
  border: "1px solid var(--border)",
  borderRadius: "6px",
};
