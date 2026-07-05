import { describe, expect, it } from "vitest";
import {
  isHistoricalEnd,
  parseHistoricalBar,
  parseIbDate,
  parseRealtimeBar,
} from "./bar-parser.js";
import type { RawHistoricalBar } from "./types.js";

/**
 * Recorded historical-data stream for QUAL daily bars, in the exact positional
 * shape `EventName.historicalData` emits (mapped to {@link RawHistoricalBar}).
 * The trailing entry is the `finished-…` sentinel IB sends to close the stream.
 * This fixture proves the parsing path off market hours (T0.5 AC).
 */
const QUAL_DAILY_STREAM: RawHistoricalBar[] = [
  {
    date: "20240701",
    open: 168.12,
    high: 169.4,
    low: 167.8,
    close: 169.1,
    volume: 12045,
  },
  {
    date: "20240702",
    open: 169.2,
    high: 170.05,
    low: 168.9,
    close: 169.85,
    volume: 9877,
  },
  {
    date: "20240703",
    open: 169.9,
    high: 171.2,
    low: 169.6,
    close: 170.75,
    volume: 15320,
  },
  // A malformed bar mid-stream (IB occasionally emits -1 padding): must drop.
  { date: "20240704", open: -1, high: -1, low: -1, close: -1, volume: -1 },
  {
    date: "20240705",
    open: 170.8,
    high: 172.0,
    low: 170.5,
    close: 171.9,
    volume: 18110,
  },
  {
    date: "finished-20240701-20240705",
    open: -1,
    high: -1,
    low: -1,
    close: -1,
    volume: -1,
  },
];

describe("parseIbDate", () => {
  it("parses an 8-digit YYYYMMDD as UTC midnight", () => {
    expect(parseIbDate("20240705")?.toISOString()).toBe(
      "2024-07-05T00:00:00.000Z",
    );
  });

  it("parses epoch seconds", () => {
    // 1720137600 = 2024-07-05T00:00:00Z
    expect(parseIbDate("1720137600")?.toISOString()).toBe(
      "2024-07-05T00:00:00.000Z",
    );
  });

  it("parses 'YYYYMMDD  HH:mm:ss'", () => {
    expect(parseIbDate("20240705  14:30:00")?.toISOString()).toBe(
      "2024-07-05T14:30:00.000Z",
    );
  });

  it("returns null for junk", () => {
    expect(parseIbDate("")).toBeNull();
    expect(parseIbDate("not-a-date")).toBeNull();
  });
});

describe("isHistoricalEnd", () => {
  it("detects the finished sentinel", () => {
    expect(isHistoricalEnd({ date: "finished-20240701-20240705" })).toBe(true);
    expect(isHistoricalEnd({ date: "20240705" })).toBe(false);
  });
});

describe("parseHistoricalBar", () => {
  const ctx = { ticker: "QUAL", timeframe: "1d" };

  it("maps a valid daily bar to a candle row with string numerics", () => {
    const row = parseHistoricalBar(QUAL_DAILY_STREAM[0]!, ctx);
    expect(row).toEqual({
      ticker: "QUAL",
      timeframe: "1d",
      ts: new Date("2024-07-01T00:00:00.000Z"),
      open: "168.12",
      high: "169.4",
      low: "167.8",
      close: "169.1",
      volume: "12045",
    });
  });

  it("drops the finished sentinel and malformed (-1) bars", () => {
    expect(parseHistoricalBar(QUAL_DAILY_STREAM[3]!, ctx)).toBeNull(); // -1 pad
    expect(parseHistoricalBar(QUAL_DAILY_STREAM[5]!, ctx)).toBeNull(); // sentinel
  });

  it("parses the whole recorded stream into exactly the valid candles", () => {
    const rows = QUAL_DAILY_STREAM.map((b) =>
      parseHistoricalBar(b, ctx),
    ).filter((r): r is NonNullable<typeof r> => r !== null);
    expect(rows).toHaveLength(4);
    expect(rows[0]!.ts.toISOString()).toBe("2024-07-01T00:00:00.000Z");
    expect(rows.at(-1)!.ts.toISOString()).toBe("2024-07-05T00:00:00.000Z");
    expect(rows.at(-1)!.close).toBe("171.9");
  });
});

describe("parseRealtimeBar", () => {
  const ctx = { ticker: "SPY", timeframe: "5s" };

  it("maps a realtime 5s bar (epoch seconds) to a candle row", () => {
    const row = parseRealtimeBar(
      {
        time: 1720190100,
        open: 553.1,
        high: 553.3,
        low: 553.0,
        close: 553.25,
        volume: 4200,
      },
      ctx,
    );
    expect(row?.ts.toISOString()).toBe("2024-07-05T14:35:00.000Z");
    expect(row?.close).toBe("553.25");
    expect(row?.ticker).toBe("SPY");
  });

  it("returns null on invalid time or ohlc", () => {
    expect(
      parseRealtimeBar(
        { time: Number.NaN, open: 1, high: 1, low: 1, close: 1, volume: 1 },
        ctx,
      ),
    ).toBeNull();
    expect(
      parseRealtimeBar(
        { time: 1720190100, open: -1, high: -1, low: -1, close: -1, volume: 0 },
        ctx,
      ),
    ).toBeNull();
  });
});
