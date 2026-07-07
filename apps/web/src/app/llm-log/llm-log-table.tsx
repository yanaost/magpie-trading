"use client";

import type { ReactNode } from "react";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import type {
  LlmLogDetail,
  LlmLogListItem,
  LlmLogPage,
  LlmLogQuery,
} from "@/lib/api";
import { getLlmLog, getLlmLogs } from "@/lib/browser-api";

const PAGE_SIZE = 50;

/** Badge for the model's verdict (proceed/veto), or a dash when there is none. */
function VerdictBadge({ verdict }: { verdict: string | null }): ReactNode {
  if (!verdict) return <span className="muted">—</span>;
  return <span className={`badge ${verdict}`}>{verdict}</span>;
}

/** Badge for what actually happened; failures get the amber "fail" style. */
function OutcomeBadge({ outcome }: { outcome: string | null }): ReactNode {
  if (!outcome) return <span className="muted">—</span>;
  const cls =
    outcome === "veto_by_failure"
      ? "fail"
      : outcome === "proceed"
        ? "proceed"
        : "veto";
  return <span className={`badge ${cls}`}>{outcome}</span>;
}

/**
 * Interactive LLM dialog-log table (U1): filter, paginate, and expand any row
 * to see the full captured dialog (prompts, web-search activity, raw response,
 * parsed verdict + validation, and error text for failed calls).
 */
export default function LlmLogTable({
  initial,
  initialQuery,
}: {
  initial: LlmLogPage | null;
  initialQuery: LlmLogQuery;
}): ReactNode {
  const [page, setPage] = useState<LlmLogPage | null>(initial);
  const [query, setQuery] = useState<LlmLogQuery>(initialQuery);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = useCallback(async (q: LlmLogQuery) => {
    setLoading(true);
    setError(null);
    try {
      const next = await getLlmLogs({ ...q, limit: PAGE_SIZE });
      setPage(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  // Update a single filter field, reset to the first page, and refetch.
  function setFilter(patch: Partial<LlmLogQuery>): void {
    const next = { ...query, ...patch, offset: 0 };
    setQuery(next);
    setExpanded(null);
    void load(next);
  }

  function goto(offset: number): void {
    const next = { ...query, offset };
    setQuery(next);
    setExpanded(null);
    void load(next);
  }

  const items = page?.items ?? [];
  const total = page?.total ?? 0;
  const offset = query.offset ?? 0;

  return (
    <div>
      <div className="filter-bar">
        <input
          type="text"
          placeholder="Ticker"
          defaultValue={query.ticker ?? ""}
          onChange={(e) =>
            setFilter({ ticker: e.target.value.toUpperCase() || undefined })
          }
          style={{ width: "6rem" }}
        />
        <select
          value={query.purpose ?? ""}
          onChange={(e) => setFilter({ purpose: e.target.value || undefined })}
        >
          <option value="">All purposes</option>
          <option value="signal_analysis">signal_analysis</option>
          <option value="crowding_scan">crowding_scan</option>
        </select>
        <select
          value={query.verdict ?? ""}
          onChange={(e) => setFilter({ verdict: e.target.value || undefined })}
        >
          <option value="">All verdicts</option>
          <option value="proceed">proceed</option>
          <option value="veto">veto</option>
        </select>
        <select
          value={query.outcome ?? ""}
          onChange={(e) => setFilter({ outcome: e.target.value || undefined })}
        >
          <option value="">All outcomes</option>
          <option value="proceed">proceed</option>
          <option value="veto">veto</option>
          <option value="veto_by_failure">veto_by_failure</option>
        </select>
        <input
          type="date"
          value={query.from ?? ""}
          onChange={(e) => setFilter({ from: e.target.value || undefined })}
        />
        <input
          type="date"
          value={query.to ?? ""}
          onChange={(e) => setFilter({ to: e.target.value || undefined })}
        />
        {query.signalId ? (
          <button
            type="button"
            onClick={() => setFilter({ signalId: undefined })}
          >
            Clear signal filter
          </button>
        ) : null}
      </div>

      {error ? <p className="error">Could not load: {error}</p> : null}

      <div className="panel">
        {items.length === 0 ? (
          <p className="muted">
            {loading ? "Loading…" : "No LLM calls match these filters."}
          </p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Time</th>
                <th>Purpose</th>
                <th>Ticker</th>
                <th>Verdict</th>
                <th>Outcome</th>
                <th>Model</th>
                <th>Latency</th>
              </tr>
            </thead>
            <tbody>
              {items.map((r) => (
                <LogRow
                  key={r.id}
                  row={r}
                  open={expanded === r.id}
                  onToggle={() =>
                    setExpanded((cur) => (cur === r.id ? null : r.id))
                  }
                />
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="pager">
        <span className="muted">
          {total === 0
            ? "0 results"
            : `${offset + 1}–${Math.min(offset + PAGE_SIZE, total)} of ${total}`}
        </span>
        <button
          type="button"
          disabled={offset === 0 || loading}
          onClick={() => goto(Math.max(0, offset - PAGE_SIZE))}
        >
          ← Prev
        </button>
        <button
          type="button"
          disabled={offset + PAGE_SIZE >= total || loading}
          onClick={() => goto(offset + PAGE_SIZE)}
        >
          Next →
        </button>
      </div>
    </div>
  );
}

/** One table row plus, when open, an inline detail panel with the full dialog. */
function LogRow({
  row,
  open,
  onToggle,
}: {
  row: LlmLogListItem;
  open: boolean;
  onToggle: () => void;
}): ReactNode {
  return (
    <>
      <tr className="log-row" onClick={onToggle}>
        <td className="muted" style={{ whiteSpace: "nowrap" }}>
          {new Date(row.createdAt).toLocaleString()}
        </td>
        <td>{row.purpose}</td>
        <td>{row.ticker ?? "—"}</td>
        <td>
          <VerdictBadge verdict={row.verdict} />
        </td>
        <td>
          <OutcomeBadge outcome={row.outcome} />
        </td>
        <td className="muted">{row.model}</td>
        <td className="muted">
          {row.latencyMs === null ? "—" : `${row.latencyMs} ms`}
        </td>
      </tr>
      {open ? (
        <tr>
          <td colSpan={7}>
            <DialogDetail id={row.id} />
          </td>
        </tr>
      ) : null}
    </>
  );
}

/** Lazily fetches and renders the full captured dialog for one row. */
function DialogDetail({ id }: { id: string }): ReactNode {
  const [detail, setDetail] = useState<LlmLogDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    getLlmLog(id)
      .then((d) => {
        if (live) setDetail(d);
      })
      .catch((err) => {
        if (live) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      live = false;
    };
  }, [id]);

  if (error) return <p className="error">Could not load dialog: {error}</p>;
  if (!detail) return <p className="muted">Loading dialog…</p>;

  return (
    <div className="dialog">
      {detail.errorText ? (
        <div>
          <h4>Error (call failed)</h4>
          <pre className="error">{detail.errorText}</pre>
        </div>
      ) : null}

      <div>
        <h4>System prompt</h4>
        <pre>{detail.systemPrompt ?? "—"}</pre>
      </div>

      <div>
        <h4>User prompt</h4>
        <pre>{detail.userPrompt ?? "—"}</pre>
      </div>

      <div>
        <h4>
          Web searches{" "}
          {detail.webSearches ? `(${detail.webSearches.length})` : "(none)"}
        </h4>
        {detail.webSearches && detail.webSearches.length > 0 ? (
          <ul className="mono">
            {detail.webSearches.map((s, i) => (
              <li key={i}>{s.query}</li>
            ))}
          </ul>
        ) : (
          <p className="muted">No web searches recorded.</p>
        )}
      </div>

      <div>
        <h4>Parsed verdict</h4>
        <p>
          <VerdictBadge verdict={detail.verdict} />{" "}
          <OutcomeBadge outcome={detail.outcome} />
          {detail.confidence !== null ? (
            <span className="muted"> · confidence {detail.confidence}</span>
          ) : null}
        </p>
        {detail.reasoning ? <pre>{detail.reasoning}</pre> : null}
        {detail.flaggedRisks.length > 0 ? (
          <ul className="mono">
            {detail.flaggedRisks.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        ) : (
          <p className="muted">No flagged risks.</p>
        )}
      </div>

      <div>
        <h4>Request params</h4>
        <pre>{JSON.stringify(detail.params, null, 2)}</pre>
      </div>

      <div>
        <h4>Raw response</h4>
        <pre>{detail.rawResponse ?? "—"}</pre>
      </div>

      {detail.signalId ? (
        <div>
          <Link className="badge" href="/#signal-log">
            ← Back to signal log
          </Link>
        </div>
      ) : null}
    </div>
  );
}
