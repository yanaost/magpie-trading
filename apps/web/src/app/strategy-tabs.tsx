"use client";

import type { CSSProperties, ReactNode } from "react";
import { useEffect, useState } from "react";
import type {
  BacktestRunView,
  JournalView,
  PerformanceStats,
  PerformanceView,
  PositionView,
  StrategyMeta,
  StrategySummary,
} from "@/lib/api";
import { getBacktests, getPerformance } from "@/lib/browser-api";
import StrategyControls from "./strategy-controls";
import { ModeChip, TargetChip } from "./chip";
import { useLiveStrategies } from "./use-live-strategies";

const TARGETS = ["SIM", "PAPER", "LIVE"] as const;

/**
 * Strategy tabs (T2.3): one tab per registered strategy, each showing the full
 * §3.3 layout — mode/target controls, the per-target performance module (win
 * rate, avg R, max drawdown, equity curve), that strategy's open positions, and
 * its signal log with veto reasons. Entirely data-driven off the strategy
 * roster the API returns: registering a new strategy grows a tab here with zero
 * changes to this file (T2.3 AC).
 */
export default function StrategyTabs({
  strategies,
  positions,
  signals,
}: {
  strategies: StrategySummary[];
  positions: PositionView[];
  signals: JournalView[];
}): ReactNode {
  const [active, setActive] = useState(strategies[0]?.id ?? "");

  // The SSR roster is a point-in-time snapshot; mode/target can change from
  // another browser tab, the kill switch, or this session. The shared hook keeps
  // it live over the WebSocket (plus a poll backstop) so the tab-strip chips
  // track reality instead of freezing on the first render (spec §U3).
  const { strategies: roster, applyChange } = useLiveStrategies(strategies);

  if (roster.length === 0) {
    return <p className="muted">No strategies configured yet.</p>;
  }

  const current = roster.find((s) => s.id === active) ?? roster[0]!;

  return (
    <div>
      <div className="row" role="tablist" style={tabBarStyle}>
        {roster.map((s) => {
          const selected = s.id === current.id;
          return (
            <button
              key={s.id}
              role="tab"
              aria-selected={selected}
              onClick={() => setActive(s.id)}
              style={selected ? { ...tabStyle, ...activeTabStyle } : tabStyle}
            >
              <span
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "0.35rem",
                }}
              >
                {s.name}
                <ModeChip mode={s.mode} />
                <TargetChip target={s.target} />
              </span>
              <span className="muted" style={{ fontSize: "0.72rem" }}>
                {s.timeframe}
              </span>
            </button>
          );
        })}
      </div>

      <StrategyPanel
        key={current.id}
        strategy={current}
        positions={positions.filter((p) => p.strategyId === current.id)}
        signals={signals.filter((s) => s.strategyId === current.id)}
        onChanged={applyChange}
      />
    </div>
  );
}

/** The full layout for one selected strategy. */
function StrategyPanel({
  strategy,
  positions,
  signals,
  onChanged,
}: {
  strategy: StrategySummary;
  positions: PositionView[];
  signals: JournalView[];
  onChanged?: (updated: StrategySummary) => void;
}): ReactNode {
  return (
    <div className="panel" style={{ marginTop: "0.75rem" }}>
      {strategy.meta ? <AboutStrategy meta={strategy.meta} /> : null}

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
          <StrategyControls strategy={strategy} onChanged={onChanged} />
        </tbody>
      </table>

      <h3 style={sectionStyle}>Performance</h3>
      <Performance strategyId={strategy.id} />

      <VariantBacktests strategyId={strategy.id} />

      <h3 style={sectionStyle}>Open positions</h3>
      {positions.length === 0 ? (
        <p className="muted">No open positions.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Ticker</th>
              <th>Side</th>
              <th>Qty</th>
              <th>Entry</th>
              <th>Stop</th>
              <th>Dist %</th>
              <th>Risk $</th>
            </tr>
          </thead>
          <tbody>
            {positions.map((p) => (
              <tr key={`${p.ticker}:${p.openedAt}`}>
                <td>{p.ticker}</td>
                <td>{p.side}</td>
                <td>{p.qty}</td>
                <td>{p.avgEntryPrice}</td>
                <td>{p.stopPrice ?? "—"}</td>
                <td>{p.distanceToStopPct ?? "—"}</td>
                <td>{p.openRiskUsd.toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h3 style={sectionStyle}>Signal log</h3>
      {signals.length === 0 ? (
        <p className="muted">No signals logged yet.</p>
      ) : (
        <ul style={{ margin: 0, paddingLeft: "1.1rem" }}>
          {signals.slice(0, 20).map((s) => (
            <li key={s.id} style={{ marginBottom: "0.3rem" }}>
              <strong>{s.title}</strong>
              {s.body ? <span className="muted"> — {s.body}</span> : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * "About this strategy" (spec §U2): a collapsible plain-language explainer at the
 * top of each tab — summary, the entry checklist, the exit plan, what Claude
 * verifies, and the data it needs. Shows a warning chip when that data feed is
 * still a stub provider so an operator never mistakes a WATCH-only stub for a
 * live, tradeable setup. Rendered open by default via native <details>.
 */
function AboutStrategy({ meta }: { meta: StrategyMeta }): ReactNode {
  return (
    <details open style={aboutStyle}>
      <summary style={aboutSummaryStyle}>About this strategy</summary>

      <p style={{ margin: "0.6rem 0 0.4rem" }}>{meta.summary}</p>

      {!meta.dataReady ? (
        <div style={{ margin: "0.5rem 0" }}>
          <span
            className="badge"
            title="This strategy's data feed is a placeholder — it will not produce live signals until the feed is connected."
            style={{
              borderColor: "var(--degraded)",
              color: "var(--degraded)",
            }}
          >
            <span className="dot" style={{ background: "var(--degraded)" }} />
            data feed not wired
          </span>
        </div>
      ) : null}

      <div className="row" style={{ gap: "1.5rem", flexWrap: "wrap" }}>
        <AboutList title="Entry checklist" items={meta.mechanic.trigger} />
        <AboutList title="Exit plan" items={meta.mechanic.exitPlan} />
      </div>

      <dl style={aboutMetaGrid}>
        <div>
          <dt className="muted" style={aboutTermStyle}>
            Claude&apos;s role
          </dt>
          <dd style={{ margin: 0 }}>{meta.mechanic.llmRole}</dd>
        </div>
        <div>
          <dt className="muted" style={aboutTermStyle}>
            Data it needs
          </dt>
          <dd style={{ margin: 0 }}>{meta.mechanic.dataNeeds}</dd>
        </div>
      </dl>
    </details>
  );
}

function AboutList({
  title,
  items,
}: {
  title: string;
  items: string[];
}): ReactNode {
  return (
    <div style={{ flex: "1 1 260px", minWidth: "240px" }}>
      <div className="muted" style={aboutTermStyle}>
        {title}
      </div>
      <ul style={{ margin: "0.25rem 0 0", paddingLeft: "1.1rem" }}>
        {items.map((line, i) => (
          <li key={i} style={{ marginBottom: "0.2rem" }}>
            {line}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Per-target performance cards + a tiny equity-curve sparkline. */
function Performance({ strategyId }: { strategyId: string }): ReactNode {
  const [perf, setPerf] = useState<PerformanceView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setPerf(null);
    setError(null);
    getPerformance(strategyId)
      .then((p) => {
        if (live) setPerf(p);
      })
      .catch((err: unknown) => {
        if (live) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      live = false;
    };
  }, [strategyId]);

  if (error)
    return <p className="error">Could not load performance: {error}</p>;
  if (!perf) return <p className="muted">Loading performance…</p>;

  return (
    <div className="row" style={{ gap: "1rem", flexWrap: "wrap" }}>
      {TARGETS.map((t) => (
        <TargetCard key={t} target={t} stats={perf.byTarget[t]} />
      ))}
    </div>
  );
}

/**
 * Variant backtest comparison (T3.5, §4.4). Shows one row per persisted variant
 * run — trades, win rate, avg R, max drawdown, net P&L — so two wait-time
 * variants can be compared side by side. Any run whose LLM analysis was
 * synthesized carries a visible `REPLAY_STUBBED` badge: backtests are
 * directional evidence only. The section hides itself for strategies that have
 * never been backtested (most don't support variants).
 */
function VariantBacktests({ strategyId }: { strategyId: string }): ReactNode {
  const [runs, setRuns] = useState<BacktestRunView[] | null>(null);

  useEffect(() => {
    let live = true;
    setRuns(null);
    getBacktests(strategyId)
      .then((r) => {
        if (live) setRuns(r);
      })
      .catch(() => {
        if (live) setRuns([]);
      });
    return () => {
      live = false;
    };
  }, [strategyId]);

  if (!runs || runs.length === 0) return null;

  // Newest run per variant instance, ordered by wait so 30 sits above 60.
  const latest = new Map<string, BacktestRunView>();
  for (const run of runs) {
    if (!latest.has(run.instanceId)) latest.set(run.instanceId, run);
  }
  const rows = [...latest.values()].sort((a, b) =>
    a.instanceId.localeCompare(b.instanceId),
  );
  const anyStubbed = rows.some((r) => r.replayStubbed);

  return (
    <>
      <h3 style={sectionStyle}>
        Variant backtests {anyStubbed ? <ReplayStubbedBadge /> : null}
      </h3>
      <table>
        <thead>
          <tr>
            <th>Variant</th>
            <th>Window</th>
            <th>Trades</th>
            <th>Win rate</th>
            <th>Avg R</th>
            <th>Max DD</th>
            <th>Net P&amp;L</th>
            <th>LLM</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((run) => {
            const p = run.report.performance;
            return (
              <tr key={run.id}>
                <td>{run.label}</td>
                <td className="muted" style={{ fontSize: "0.72rem" }}>
                  {run.from.slice(0, 10)} → {run.to.slice(0, 10)}
                </td>
                <td>{p.trades}</td>
                <td>{(p.winRate * 100).toFixed(0)}%</td>
                <td>{p.avgR.toFixed(2)}</td>
                <td>${p.maxDrawdown.toLocaleString()}</td>
                <td
                  style={{
                    color: p.totalPnl >= 0 ? "var(--up)" : "var(--down)",
                  }}
                >
                  ${p.totalPnl.toLocaleString()}
                </td>
                <td>
                  {run.replayStubbed ? (
                    <span
                      className="muted"
                      title={`${run.report.stubbing.stubbed}/${run.report.stubbing.analyses} analyses stubbed`}
                      style={{ fontSize: "0.72rem" }}
                    >
                      stubbed{" "}
                      {(run.report.stubbing.stubbedFraction * 100).toFixed(0)}%
                    </span>
                  ) : (
                    <span className="muted" style={{ fontSize: "0.72rem" }}>
                      cached
                    </span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {anyStubbed ? (
        <p
          className="muted"
          style={{ margin: "0.4rem 0 0", fontSize: "0.72rem" }}
        >
          REPLAY_STUBBED — some LLM verdicts were synthesized (no cached
          historical analysis). Treat as directional; confirm on
          replay-with-cache or live-sim before promoting.
        </p>
      ) : null}
    </>
  );
}

function ReplayStubbedBadge(): ReactNode {
  return (
    <span
      style={{
        marginLeft: "0.5rem",
        padding: "0.05rem 0.4rem",
        borderRadius: "6px",
        border: "1px solid var(--down)",
        color: "var(--down)",
        fontSize: "0.62rem",
        fontWeight: 600,
        letterSpacing: "0.03em",
        verticalAlign: "middle",
      }}
    >
      REPLAY_STUBBED
    </span>
  );
}

function TargetCard({
  target,
  stats,
}: {
  target: string;
  stats: PerformanceStats | undefined;
}): ReactNode {
  const s = stats ?? {
    trades: 0,
    wins: 0,
    losses: 0,
    winRate: 0,
    avgR: 0,
    totalPnl: 0,
    maxDrawdown: 0,
    equityCurve: [],
  };
  return (
    <div style={cardStyle}>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <strong>{target}</strong>
        <span className="muted">{s.trades} trades</span>
      </div>
      {s.trades === 0 ? (
        <p className="muted" style={{ margin: "0.4rem 0 0" }}>
          No closed trades yet.
        </p>
      ) : (
        <>
          <dl style={statGrid}>
            <Stat label="Win rate" value={`${(s.winRate * 100).toFixed(0)}%`} />
            <Stat label="Avg R" value={s.avgR.toFixed(2)} />
            <Stat label="Max DD" value={`$${s.maxDrawdown.toLocaleString()}`} />
            <Stat
              label="Net P&L"
              value={`$${s.totalPnl.toLocaleString()}`}
              tone={s.totalPnl >= 0 ? "var(--up)" : "var(--down)"}
            />
          </dl>
          <Sparkline points={s.equityCurve.map((p) => p.equity)} />
        </>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: string;
}): ReactNode {
  return (
    <div>
      <dt className="muted" style={{ fontSize: "0.72rem" }}>
        {label}
      </dt>
      <dd style={{ margin: 0, fontWeight: 600, color: tone ?? "inherit" }}>
        {value}
      </dd>
    </div>
  );
}

/** A dependency-free inline-SVG equity sparkline. */
function Sparkline({ points }: { points: number[] }): ReactNode {
  if (points.length < 2) return null;
  const w = 200;
  const h = 40;
  const min = Math.min(...points, 0);
  const max = Math.max(...points, 0);
  const span = max - min || 1;
  const step = w / (points.length - 1);
  const path = points
    .map((v, i) => {
      const x = i * step;
      const y = h - ((v - min) / span) * h;
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  const last = points[points.length - 1]!;
  return (
    <svg
      width={w}
      height={h}
      viewBox={`0 0 ${w} ${h}`}
      style={{ marginTop: "0.5rem", display: "block" }}
      aria-label="equity curve"
    >
      <path
        d={path}
        fill="none"
        stroke={last >= 0 ? "var(--up)" : "var(--down)"}
        strokeWidth={1.5}
      />
    </svg>
  );
}

const tabBarStyle: CSSProperties = {
  gap: "0.4rem",
  flexWrap: "wrap",
  borderBottom: "1px solid var(--border)",
  paddingBottom: "0.5rem",
};

const tabStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "flex-start",
  gap: "0.1rem",
  padding: "0.4rem 0.7rem",
  background: "var(--bg)",
  color: "var(--text)",
  // Longhand border props (not the `border` shorthand) so the active variant can
  // override borderColor alone without React warning about mixing shorthand and
  // non-shorthand for the same value on re-render.
  borderWidth: "1px",
  borderStyle: "solid",
  borderColor: "var(--border)",
  borderRadius: "8px",
  cursor: "pointer",
};

const activeTabStyle: CSSProperties = {
  borderColor: "var(--up)",
  background: "var(--panel)",
};

const sectionStyle: CSSProperties = {
  margin: "1rem 0 0.5rem",
  fontSize: "0.95rem",
};

const aboutStyle: CSSProperties = {
  marginBottom: "1rem",
  padding: "0.75rem 1rem",
  border: "1px solid var(--border)",
  borderRadius: "10px",
  background: "var(--bg)",
};

const aboutSummaryStyle: CSSProperties = {
  cursor: "pointer",
  fontWeight: 600,
  fontSize: "0.95rem",
};

const aboutMetaGrid: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "1fr 1fr",
  gap: "0.75rem 1.5rem",
  margin: "0.75rem 0 0",
};

const aboutTermStyle: CSSProperties = {
  fontSize: "0.72rem",
  textTransform: "uppercase",
  letterSpacing: "0.03em",
};

const cardStyle: CSSProperties = {
  flex: "1 1 220px",
  minWidth: "200px",
  padding: "0.75rem",
  border: "1px solid var(--border)",
  borderRadius: "10px",
  background: "var(--bg)",
};

const statGrid: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "1fr 1fr",
  gap: "0.5rem",
  margin: "0.5rem 0 0",
};
