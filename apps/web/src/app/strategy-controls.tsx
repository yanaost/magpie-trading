"use client";

import type { CSSProperties, ReactNode } from "react";
import { useEffect, useState } from "react";
import type { StrategySummary } from "@/lib/api";
import { setStrategy, triggerSynthetic } from "@/lib/browser-api";
import {
  MODE_DESCRIPTIONS,
  TARGET_DESCRIPTIONS,
  MODE_OPTIONS,
  TARGET_OPTIONS,
  modeCaption,
  targetCaption,
  needsAutoConfirmation,
} from "@/lib/strategy-copy";

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
  // When set, the switch-to-AUTO confirmation is open and the change is held
  // until the operator confirms it (spec §U4).
  const [confirmAuto, setConfirmAuto] = useState(false);

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

  /**
   * Switching *to* AUTO (hands-off trading) is gated behind an explicit
   * confirmation showing what AUTO does and the daily trade cap (spec §U4).
   * Every other mode applies immediately. The change is never sent until
   * {@link confirmAutoChange} runs, so AUTO can't be entered by a stray click.
   */
  function selectMode(next: string): void {
    if (needsAutoConfirmation(next)) {
      setError(null);
      setConfirmAuto(true);
      return;
    }
    void change({ mode: next });
  }

  function confirmAutoChange(): void {
    setConfirmAuto(false);
    void change({ mode: "AUTO" });
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
        <div style={selectorRowStyle}>
          <span className="badge" style={{ borderColor: badgeTone(mode) }}>
            <span className="dot" style={{ background: badgeTone(mode) }} />
            {mode}
          </span>
          <select
            aria-label={`${strategy.name} mode`}
            value={mode}
            disabled={busy}
            onChange={(e) => selectMode(e.target.value)}
            style={selectStyle}
          >
            {MODE_OPTIONS.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
          <InfoPopover
            title="What the modes mean"
            options={MODE_OPTIONS}
            descriptions={MODE_DESCRIPTIONS}
          />
        </div>
        <p style={captionStyle}>{modeCaption(mode, strategy.proposalTtlMs)}</p>
        {confirmAuto ? (
          <div
            style={confirmStyle}
            role="alertdialog"
            aria-label="Confirm AUTO"
          >
            <strong>Switch {strategy.name} to AUTO?</strong>
            <p style={{ margin: "0.35rem 0" }}>{MODE_DESCRIPTIONS.AUTO}</p>
            <p className="muted" style={{ margin: "0.35rem 0" }}>
              Daily trade cap: up to {strategy.autoMaxTradesPerDay} trade
              {strategy.autoMaxTradesPerDay === 1 ? "" : "s"} per day.
            </p>
            <div
              style={{ display: "flex", gap: "0.4rem", marginTop: "0.4rem" }}
            >
              <button
                disabled={busy}
                onClick={confirmAutoChange}
                style={{ borderColor: "var(--down)", color: "var(--down)" }}
              >
                Enable AUTO
              </button>
              <button disabled={busy} onClick={() => setConfirmAuto(false)}>
                Cancel
              </button>
            </div>
          </div>
        ) : null}
      </td>
      <td>
        <div style={selectorRowStyle}>
          <select
            aria-label={`${strategy.name} target`}
            value={target}
            disabled={busy}
            onChange={(e) => changeTarget(e.target.value)}
            style={selectStyle}
          >
            {TARGET_OPTIONS.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          <InfoPopover
            title="What the targets mean"
            options={TARGET_OPTIONS}
            descriptions={TARGET_DESCRIPTIONS}
          />
        </div>
        <p style={captionStyle}>{targetCaption(target)}</p>
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

/**
 * A tap-to-open info popover (spec §U4) listing every option for a selector with
 * its one-line description. Native `<details>` so it needs no outside-click
 * wiring and stays keyboard-accessible; the summary is a small "ⓘ" affordance.
 */
function InfoPopover({
  title,
  options,
  descriptions,
}: {
  title: string;
  options: readonly string[];
  descriptions: Record<string, string>;
}): ReactNode {
  return (
    <details style={{ position: "relative" }}>
      <summary
        className="info-i"
        aria-label={title}
        title={title}
        style={infoSummaryStyle}
      >
        ⓘ
      </summary>
      <div style={popoverStyle}>
        <div style={{ ...captionStyle, marginBottom: "0.4rem" }}>{title}</div>
        <dl style={{ margin: 0 }}>
          {options.map((opt) => (
            <div key={opt} style={{ marginBottom: "0.35rem" }}>
              <dt style={{ fontWeight: 700 }}>{opt}</dt>
              <dd style={{ margin: 0, color: "var(--muted)" }}>
                {descriptions[opt]}
              </dd>
            </div>
          ))}
        </dl>
      </div>
    </details>
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

const selectorRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.5rem",
};

const captionStyle: CSSProperties = {
  margin: "0.35rem 0 0",
  fontSize: "0.75rem",
  color: "var(--muted)",
  maxWidth: "22rem",
};

const infoSummaryStyle: CSSProperties = {
  cursor: "pointer",
  listStyle: "none",
  color: "var(--muted)",
  fontSize: "0.9rem",
  userSelect: "none",
};

const popoverStyle: CSSProperties = {
  position: "absolute",
  zIndex: 10,
  top: "1.5rem",
  left: 0,
  width: "20rem",
  background: "var(--panel)",
  border: "1px solid var(--border)",
  borderRadius: "8px",
  padding: "0.75rem",
  fontSize: "0.8rem",
  boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
};

const confirmStyle: CSSProperties = {
  marginTop: "0.5rem",
  padding: "0.6rem 0.75rem",
  background: "var(--panel)",
  border: "1px solid var(--down)",
  borderRadius: "8px",
  maxWidth: "24rem",
};
