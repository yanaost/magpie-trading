/**
 * DrizzleCrowdingFilter tests (T2.4). Uses a fake query builder that records the
 * `where` predicate count and returns a canned row, to prove the filter maps a
 * hit to {crowded, evidence} and a miss to {crowded:false} — without a live DB.
 */
import { describe, expect, it } from "vitest";
import type { DbClient } from "../infra/infra.module.js";
import type { Clock } from "../pipeline/pipeline.types.js";
import { DrizzleCrowdingFilter } from "./drizzle-crowding-filter.js";

const NOW = new Date("2026-07-05T00:00:00.000Z");
const clock: Clock = { now: () => NOW };

/** A one-shot select chain returning `rows` from `.limit()`. */
function dbReturning(rows: Array<{ evidence: string }>): DbClient {
  const chain = {
    select: () => chain,
    from: () => chain,
    where: () => chain,
    orderBy: () => chain,
    limit: () => Promise.resolve(rows),
  };
  return { db: chain as unknown as DbClient["db"] } as DbClient;
}

describe("DrizzleCrowdingFilter", () => {
  it("reports crowded with evidence when a live row exists", async () => {
    const filter = new DrizzleCrowdingFilter(
      dbReturning([{ evidence: "heavy coverage" }]),
      clock,
    );
    expect(await filter.check("AAPL")).toEqual({
      crowded: true,
      evidence: "heavy coverage",
    });
  });

  it("reports not-crowded when no live row exists", async () => {
    const filter = new DrizzleCrowdingFilter(dbReturning([]), clock);
    expect(await filter.check("AAPL")).toEqual({ crowded: false });
  });
});
