import { describe, it, expect } from "vitest";
import type { EarningsEvent } from "../earnings-fade/calendar.js";
import { buildJournalEntries } from "./journal.js";
import type { ValuationPair } from "./watchlist.js";

const WATCH: readonly ValuationPair[] = [
  { ticker: "RIVN", peer: "TSLA", rationale: "EV" },
  { ticker: "PLTR", peer: "SNOW", rationale: "software" },
];

const PS: Record<string, number> = {
  RIVN: 3, // trades rich vs TSLA
  TSLA: 6,
  PLTR: 24, // trades rich vs SNOW
  SNOW: 12,
};
const ps = (t: string) => PS[t] ?? null;

const ev = (ticker: string, reportDate: string): EarningsEvent => ({
  ticker,
  reportDate,
});

describe("buildJournalEntries — window", () => {
  const earnings = [ev("RIVN", "2024-05-07")];

  it("journals on the report date (day 0)", () => {
    const e = buildJournalEntries("2024-05-07", "s", WATCH, earnings, ps);
    expect(e).toHaveLength(1);
    expect(e[0]!.daysSinceReport).toBe(0);
  });

  it("journals on the last day of the two-week window (day 14)", () => {
    const e = buildJournalEntries("2024-05-21", "s", WATCH, earnings, ps);
    expect(e).toHaveLength(1);
    expect(e[0]!.daysSinceReport).toBe(14);
  });

  it("stops journaling after the window (day 15)", () => {
    expect(
      buildJournalEntries("2024-05-22", "s", WATCH, earnings, ps),
    ).toHaveLength(0);
  });

  it("does not journal before the report", () => {
    expect(
      buildJournalEntries("2024-05-06", "s", WATCH, earnings, ps),
    ).toHaveLength(0);
  });
});

describe("buildJournalEntries — content", () => {
  it("records the P/S premium vs the peer", () => {
    const e = buildJournalEntries(
      "2024-05-10",
      "valuation-gravity",
      WATCH,
      [ev("PLTR", "2024-05-08")],
      ps,
    );
    expect(e).toHaveLength(1);
    const entry = e[0]!;
    expect(entry.strategyId).toBe("valuation-gravity");
    expect(entry.peer).toBe("SNOW");
    expect(entry.priceToSales).toBe(24);
    expect(entry.peerPriceToSales).toBe(12);
    expect(entry.psPremium).toBe(2); // 24 / 12
    expect(entry.note).toMatch(/premium/i);
  });

  it("marks the premium null and notes it when peer data is missing", () => {
    const missingPeer = (t: string) => (t === "SNOW" ? null : (PS[t] ?? null));
    const e = buildJournalEntries(
      "2024-05-10",
      "s",
      WATCH,
      [ev("PLTR", "2024-05-08")],
      missingPeer,
    );
    expect(e[0]!.psPremium).toBeNull();
    expect(e[0]!.note).toMatch(/unavailable/i);
  });

  it("labels week 1 vs week 2", () => {
    const wk1 = buildJournalEntries(
      "2024-05-10",
      "s",
      WATCH,
      [ev("RIVN", "2024-05-07")],
      ps,
    );
    const wk2 = buildJournalEntries(
      "2024-05-18",
      "s",
      WATCH,
      [ev("RIVN", "2024-05-07")],
      ps,
    );
    expect(wk1[0]!.note).toMatch(/week 1/);
    expect(wk2[0]!.note).toMatch(/week 2/);
  });
});

describe("buildJournalEntries — selection", () => {
  it("uses the most recent in-window report when a name reported twice", () => {
    const e = buildJournalEntries(
      "2024-05-09",
      "s",
      WATCH,
      [ev("RIVN", "2024-02-21"), ev("RIVN", "2024-05-07")], // old + fresh
      ps,
    );
    expect(e).toHaveLength(1);
    expect(e[0]!.reportDate).toBe("2024-05-07");
  });

  it("ignores earnings for names not on the watchlist", () => {
    const e = buildJournalEntries(
      "2024-05-09",
      "s",
      WATCH,
      [ev("NVDA", "2024-05-08")],
      ps,
    );
    expect(e).toHaveLength(0);
  });

  it("returns entries in stable ticker order", () => {
    const e = buildJournalEntries(
      "2024-05-09",
      "s",
      WATCH,
      [ev("PLTR", "2024-05-07"), ev("RIVN", "2024-05-07")],
      ps,
    );
    expect(e.map((x) => x.ticker)).toEqual(["PLTR", "RIVN"]);
  });
});
