"use client";

import type { CSSProperties, ReactNode } from "react";
import { useState } from "react";
import type { StrategySummary } from "@/lib/api";
import { setStrategy, triggerSynthetic } from "@/lib/browser-api";

const MODES = ["AUTO", "APPROVE", "WATCH", "OFF"];
const TARGETS = ["SIM", "PAPER", "LIVE"];

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
}: {
  strategy: StrategySummary;
}): ReactNode {
  const [mode, setMode] = useState(strategy.mode);
  const [target, setTarget] = useState(strategy.target);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function change(patch: {
    mode?: string;
    target?: string;
  }): Promise<void> {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const updated = await setStrategy(strategy.id, patch);
      setMode(updated.mode);
      setTarget(updated.target);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
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
          onChange={(e) => change({ target: e.target.value })}
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
