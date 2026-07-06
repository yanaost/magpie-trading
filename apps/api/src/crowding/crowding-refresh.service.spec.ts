/**
 * CrowdingRefreshService tests (T2.4). Proves the nightly job is idempotent
 * (each run fully replaces the store), de-duplicates + upper-cases tickers, and
 * stamps the TTL-based expiry — with an in-memory fake for the Drizzle
 * transaction so no DB is required.
 */
import { describe, expect, it, vi } from "vitest";
import type { DbClient } from "../infra/infra.module.js";
import type { Clock } from "../pipeline/pipeline.types.js";
import { CrowdingRefreshService } from "./crowding-refresh.service.js";
import {
  CROWDING_TTL_DAYS,
  type CrowdingResearcher,
} from "./crowding.types.js";

/** Minimal in-memory stand-in for the crowded_tickers table + transaction. */
class FakeStore {
  rows: Array<{ ticker: string; sourceEvidence: string; expiresAt: Date }> = [];

  get db(): DbClient["db"] {
    const tx = {
      delete: () => {
        this.rows = [];
        return Promise.resolve();
      },
      insert: () => ({
        values: (
          vals: Array<{
            ticker: string;
            sourceEvidence: string;
            expiresAt: Date;
          }>,
        ) => {
          this.rows.push(...vals);
          return Promise.resolve();
        },
      }),
    };
    return {
      transaction: async (fn: (t: typeof tx) => Promise<void>) => fn(tx),
    } as unknown as DbClient["db"];
  }
}

const NOW = new Date("2026-07-05T00:00:00.000Z");
const clock: Clock = { now: () => NOW };

function researcherOf(
  ...batches: Array<Array<{ ticker: string; evidence: string }>>
): CrowdingResearcher {
  const calls = vi.fn();
  let i = 0;
  return {
    research: async () => {
      calls();
      const batch = batches[Math.min(i, batches.length - 1)];
      i += 1;
      return batch ?? [];
    },
  };
}

describe("CrowdingRefreshService", () => {
  it("replaces the store idempotently across repeated runs", async () => {
    const store = new FakeStore();
    const svc = new CrowdingRefreshService(
      { db: store.db } as DbClient,
      clock,
      researcherOf([
        { ticker: "AAPL", evidence: "hype" },
        { ticker: "NVDA", evidence: "upgrades" },
      ]),
    );

    const first = await svc.refresh();
    expect(first.tickers).toEqual(["AAPL", "NVDA"]);
    expect(store.rows).toHaveLength(2);

    // A second run with the same input yields the same set — no duplicates.
    const second = await svc.refresh();
    expect(second.tickers).toEqual(["AAPL", "NVDA"]);
    expect(store.rows).toHaveLength(2);
  });

  it("upper-cases and de-duplicates tickers, keeping first evidence", async () => {
    const store = new FakeStore();
    const svc = new CrowdingRefreshService(
      { db: store.db } as DbClient,
      clock,
      researcherOf([
        { ticker: "aapl", evidence: "first" },
        { ticker: "AAPL", evidence: "dup — dropped" },
        { ticker: " tsla ", evidence: "trimmed" },
      ]),
    );

    const res = await svc.refresh();
    expect(res.tickers).toEqual(["AAPL", "TSLA"]);
    expect(store.rows.find((r) => r.ticker === "AAPL")?.sourceEvidence).toBe(
      "first",
    );
  });

  it("stamps a TTL-based expiry", async () => {
    const store = new FakeStore();
    const svc = new CrowdingRefreshService(
      { db: store.db } as DbClient,
      clock,
      researcherOf([{ ticker: "AAPL", evidence: "hype" }]),
    );

    const res = await svc.refresh();
    const expected = new Date(
      NOW.getTime() + CROWDING_TTL_DAYS * 24 * 60 * 60 * 1000,
    );
    expect(res.expiresAt).toBe(expected.toISOString());
    expect(store.rows[0]?.expiresAt.toISOString()).toBe(expected.toISOString());
  });

  it("clears the store when nothing is crowded", async () => {
    const store = new FakeStore();
    store.rows = [{ ticker: "OLD", sourceEvidence: "stale", expiresAt: NOW }];
    const svc = new CrowdingRefreshService(
      { db: store.db } as DbClient,
      clock,
      researcherOf([]),
    );

    const res = await svc.refresh();
    expect(res.tickers).toEqual([]);
    expect(store.rows).toHaveLength(0);
  });
});
