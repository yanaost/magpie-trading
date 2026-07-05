import type { ReactNode } from "react";
import Link from "next/link";
import { requireAuth } from "@/lib/auth";
import { fetchJournal, type JournalView } from "@/lib/api";

export const dynamic = "force-dynamic";

/**
 * The full trading journal (T1.9): every decision and note, newest first. The
 * dashboard's signal log is the `decision`-only slice of this; here we show all
 * entry types with their metadata.
 */
export default async function JournalPage(): Promise<ReactNode> {
  await requireAuth();

  let entries: JournalView[] = [];
  let apiError: string | null = null;
  try {
    entries = await fetchJournal();
  } catch (err) {
    apiError = err instanceof Error ? err.message : String(err);
  }

  return (
    <main>
      <div className="row">
        <div>
          <h1>Journal</h1>
          <p className="muted">Every decision and note, newest first</p>
        </div>
        <Link className="badge" href="/">
          ← Dashboard
        </Link>
      </div>

      {apiError ? (
        <p className="error">Could not reach API: {apiError}</p>
      ) : null}

      <div className="panel" style={{ marginTop: "1rem" }}>
        {entries.length === 0 ? (
          <p className="muted">No journal entries yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Time</th>
                <th>Type</th>
                <th>Strategy</th>
                <th>Entry</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.id}>
                  <td className="muted" style={{ whiteSpace: "nowrap" }}>
                    {new Date(e.createdAt).toLocaleString()}
                  </td>
                  <td>
                    <span className="badge">{e.entryType}</span>
                  </td>
                  <td>{e.strategyId ?? "—"}</td>
                  <td>
                    <strong>{e.title}</strong>
                    {e.body ? (
                      <div className="muted" style={{ fontSize: "0.8rem" }}>
                        {e.body}
                      </div>
                    ) : null}
                    {e.refType ? (
                      <div className="muted" style={{ fontSize: "0.75rem" }}>
                        {e.refType}
                        {e.refId ? `:${e.refId.slice(0, 8)}` : ""}
                      </div>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </main>
  );
}
