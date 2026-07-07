import type { ReactNode } from "react";
import Link from "next/link";
import { requireAuth } from "@/lib/auth";
import { fetchLlmLogs, type LlmLogPage, type LlmLogQuery } from "@/lib/api";
import LlmLogTable from "./llm-log-table";

export const dynamic = "force-dynamic";

/** Read a single-valued search param (Next passes string | string[]). */
function one(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

/**
 * The LLM dialog log (U1): every model call the system made — per-signal
 * analyses and nightly crowding scans, including failed calls — with the full
 * captured dialog behind each row. Server-fetches the first page (honoring any
 * incoming filter, e.g. `?signalId=…` from a cross-link) and hands off to the
 * client table for expansion, filtering, and pagination.
 */
export default async function LlmLogPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<ReactNode> {
  await requireAuth();
  const params = await searchParams;

  const initialQuery: LlmLogQuery = {
    signalId: one(params.signalId),
    strategyId: one(params.strategyId),
    ticker: one(params.ticker),
    purpose: one(params.purpose),
    verdict: one(params.verdict),
    outcome: one(params.outcome),
    limit: 50,
    offset: 0,
  };

  let page: LlmLogPage | null = null;
  let apiError: string | null = null;
  try {
    page = await fetchLlmLogs(initialQuery);
  } catch (err) {
    apiError = err instanceof Error ? err.message : String(err);
  }

  return (
    <main>
      <div className="row">
        <div>
          <h1>LLM dialog log</h1>
          <p className="muted">
            Every model call, with its full prompt, search activity, and verdict
          </p>
        </div>
        <Link className="badge" href="/">
          ← Dashboard
        </Link>
      </div>

      {apiError ? (
        <p className="error">Could not reach API: {apiError}</p>
      ) : (
        <LlmLogTable initial={page} initialQuery={initialQuery} />
      )}
    </main>
  );
}
