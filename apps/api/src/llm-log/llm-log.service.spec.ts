/**
 * Unit tests for the LLM dialog-log query service (U1). A chainable in-memory
 * fake stands in for the Drizzle query builder so we can assert, without a DB:
 *  - filters toggle the WHERE clause (present vs. absent) and pagination flows
 *    through to `limit`/`offset`;
 *  - DB rows map to the list/detail DTOs correctly (numeric coercion, web-search
 *    count, error truncation, ISO timestamps);
 *  - an unknown id yields null (→ 404 at the controller).
 */
import { describe, expect, it } from "vitest";
import type { DbClient } from "../infra/infra.module.js";
import { LlmLogService } from "./llm-log.service.js";

/** A Drizzle-shaped query stub: every chain method returns itself; awaiting it
 *  resolves the next queued result set. Records the WHERE/limit/offset it saw. */
class FakeDb {
  readonly wheres: unknown[] = [];
  readonly limits: number[] = [];
  readonly offsets: number[] = [];
  constructor(private readonly queue: unknown[]) {}

  select(): this {
    return this.builder();
  }

  private builder(): this {
    // Arrow functions capture the instance `this` directly (no aliasing).
    const b = {
      from: () => b,
      where: (w: unknown) => {
        this.wheres.push(w);
        return b;
      },
      orderBy: () => b,
      limit: (n: number) => {
        this.limits.push(n);
        return b;
      },
      offset: (n: number) => {
        this.offsets.push(n);
        return b;
      },
      then: (resolve: (v: unknown) => void, reject: (e: unknown) => void) =>
        Promise.resolve(this.queue.shift()).then(resolve, reject),
    };
    return b as unknown as this;
  }
}

function serviceWith(queue: unknown[]): {
  service: LlmLogService;
  db: FakeDb;
} {
  const db = new FakeDb(queue);
  const service = new LlmLogService({ db } as unknown as DbClient);
  return { service, db };
}

const ROW = {
  id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  purpose: "signal_analysis",
  signalId: "11111111-1111-1111-1111-111111111111",
  strategyId: "qual-sphb",
  ticker: "QUAL",
  verdict: "proceed",
  outcome: "proceed",
  confidence: "0.8200",
  latencyMs: 1234,
  model: "claude-sonnet-5",
  webSearches: [{ query: "QUAL earnings" }, { query: "QUAL rebalance" }],
  errorText: null,
  createdAt: new Date("2026-07-05T12:00:00.000Z"),
};

describe("LlmLogService.list", () => {
  it("omits the WHERE clause when no filters are given", async () => {
    const { service, db } = serviceWith([[], [{ count: 0 }]]);

    const page = await service.list({ limit: 50, offset: 0 });

    expect(db.wheres[0]).toBeUndefined();
    expect(db.limits[0]).toBe(50);
    expect(db.offsets[0]).toBe(0);
    expect(page).toEqual({ items: [], total: 0, limit: 50, offset: 0 });
  });

  it("builds a WHERE clause when filters are present", async () => {
    const { service, db } = serviceWith([[], [{ count: 0 }]]);

    await service.list({
      strategyId: "qual-sphb",
      ticker: "QUAL",
      purpose: "signal_analysis",
      verdict: "veto",
      outcome: "veto_by_failure",
      from: new Date("2026-07-01T00:00:00.000Z"),
      to: new Date("2026-07-05T00:00:00.000Z"),
      limit: 25,
      offset: 100,
    });

    // The list query's WHERE (first select) is a combined, non-undefined clause,
    // and the same clause is reused for the count query (second select).
    expect(db.wheres[0]).toBeDefined();
    expect(db.wheres[1]).toBeDefined();
    expect(db.limits[0]).toBe(25);
    expect(db.offsets[0]).toBe(100);
  });

  it("maps DB rows to compact list items", async () => {
    const { service } = serviceWith([[ROW], [{ count: 1 }]]);

    const page = await service.list({ limit: 50, offset: 0 });

    expect(page.total).toBe(1);
    expect(page.items[0]).toEqual({
      id: ROW.id,
      purpose: "signal_analysis",
      signalId: ROW.signalId,
      strategyId: "qual-sphb",
      ticker: "QUAL",
      verdict: "proceed",
      outcome: "proceed",
      confidence: 0.82,
      latencyMs: 1234,
      model: "claude-sonnet-5",
      webSearchCount: 2,
      errorText: null,
      createdAt: "2026-07-05T12:00:00.000Z",
    });
  });

  it("truncates long error text in the list cell", async () => {
    const long = "x".repeat(500);
    const failRow = {
      ...ROW,
      verdict: null,
      outcome: "veto_by_failure",
      confidence: null,
      webSearches: null,
      errorText: long,
    };
    const { service } = serviceWith([[failRow], [{ count: 1 }]]);

    const page = await service.list({ limit: 50, offset: 0 });

    expect(page.items[0]?.confidence).toBeNull();
    expect(page.items[0]?.webSearchCount).toBeNull();
    expect(page.items[0]?.errorText).toHaveLength(201); // 200 chars + ellipsis
    expect(page.items[0]?.errorText?.endsWith("…")).toBe(true);
  });
});

describe("LlmLogService.detail", () => {
  it("returns null for an unknown id", async () => {
    const { service } = serviceWith([[]]);
    expect(await service.detail("nope")).toBeNull();
  });

  it("returns the full dialog for a known id", async () => {
    const full = {
      ...ROW,
      reasoning: "Rotation confirmed.",
      flaggedRisks: ["earnings soon"],
      systemPrompt: "You are a risk analyst.",
      userPrompt: "Ticker: QUAL",
      params: { model: "claude-sonnet-5", maxTokens: 1024 },
      rawResponse: '{"verdict":"proceed"}',
      contextHash: "deadbeef",
    };
    const { service } = serviceWith([[full]]);

    const detail = await service.detail(ROW.id);

    expect(detail).toMatchObject({
      id: ROW.id,
      reasoning: "Rotation confirmed.",
      flaggedRisks: ["earnings soon"],
      systemPrompt: "You are a risk analyst.",
      userPrompt: "Ticker: QUAL",
      params: { model: "claude-sonnet-5", maxTokens: 1024 },
      webSearches: ROW.webSearches,
      rawResponse: '{"verdict":"proceed"}',
      contextHash: "deadbeef",
      confidence: 0.82,
    });
  });
});
