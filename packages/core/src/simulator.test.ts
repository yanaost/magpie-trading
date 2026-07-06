/**
 * Simulator tests (T1.4 AC). Money-path code: the fill model, bracket
 * one-cancels-other semantics, and virtual-portfolio accounting are all
 * exercised here, including the two acceptance-criteria property tests. A seeded
 * mulberry32 PRNG keeps the "1,000 random trades" runs deterministic (no
 * `Math.random`, per the replay-determinism rule).
 */
import { describe, expect, it } from "vitest";
import { roundCents } from "./index.js";
import { LivePromotionLockedError } from "./execution.js";
import type { BracketOrderRequest } from "./execution.js";
import type { Candle } from "./market.js";
import {
  Simulator,
  ibCommission,
  marketFillPrice,
  synthesizeQuote,
} from "./simulator.js";

/** Deterministic PRNG so random-trade tests are reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const T0 = new Date("2026-01-02T15:00:00Z");
const min = (n: number) => new Date(T0.getTime() + n * 60_000);

function bar(
  ticker: string,
  fields: Partial<Candle> & { close: number },
  atMinute = 0,
): Candle {
  const c = fields.close;
  return {
    ticker,
    timeframe: "5m",
    ts: min(atMinute),
    open: fields.open ?? c,
    high: fields.high ?? Math.max(fields.open ?? c, c),
    low: fields.low ?? Math.min(fields.open ?? c, c),
    close: c,
    volume: fields.volume ?? 1_000,
  };
}

function longReq(over: Partial<BracketOrderRequest> = {}): BracketOrderRequest {
  return {
    strategyId: "qual-sphb",
    target: "SIM",
    ticker: "QUAL",
    side: "long",
    qty: 100,
    entryType: "market",
    stopPrice: 95,
    targetPrice: 110,
    timeInForce: "DAY",
    ...over,
  };
}

describe("fill model (pure)", () => {
  it("never fills at mid — buys lift the ask, sells hit the bid", () => {
    const q = synthesizeQuote(100, 10); // 10 bps spread → bid 99.95 / ask 100.05
    expect(q.bid).toBeCloseTo(99.95, 6);
    expect(q.ask).toBeCloseTo(100.05, 6);
    // Slippage is adverse in both directions.
    expect(marketFillPrice("buy", q, 5)).toBeGreaterThan(q.ask);
    expect(marketFillPrice("sell", q, 5)).toBeLessThan(q.bid);
  });

  it("applies the IB fixed tier: $0.005/share, $1 min, 1% cap", () => {
    expect(ibCommission(100, 50)).toBeCloseTo(1.0, 6); // 0.005*100=0.5 → floored to $1
    expect(ibCommission(1000, 50)).toBeCloseTo(5.0, 6); // 0.005*1000=$5
    expect(ibCommission(100, 0.5)).toBeCloseTo(0.5, 6); // cap 1% of $50 = $0.50 < $1 min
  });
});

describe("bracket lifecycle", () => {
  it("throws LivePromotionLockedError for a LIVE target", async () => {
    const sim = new Simulator();
    await expect(
      sim.placeBracket(longReq({ target: "LIVE" })),
    ).rejects.toBeInstanceOf(LivePromotionLockedError);
  });

  it("fills a market entry immediately when a quote exists", async () => {
    const sim = new Simulator();
    sim.onBar(bar("QUAL", { close: 100 }));
    const h = await sim.placeBracket(longReq());
    expect(h.parent.status).toBe("filled");
    const [pos] = await sim.getPositions("qual-sphb");
    expect(pos.qty).toBe(100);
    expect(pos.avgEntryPrice).toBeGreaterThan(100); // bought through the ask
  });

  it("waits for the next bar when no quote exists yet", async () => {
    const sim = new Simulator();
    const h = await sim.placeBracket(longReq());
    expect(h.parent.status).toBe("working");
    expect(await sim.getPositions()).toHaveLength(0);
    sim.onBar(bar("QUAL", { close: 100 }));
    expect(await sim.getPositions()).toHaveLength(1);
  });

  it("closes a long via the target and never also via the stop", async () => {
    const sim = new Simulator();
    sim.onBar(bar("QUAL", { close: 100 }, 0));
    await sim.placeBracket(longReq());
    sim.onBar(bar("QUAL", { open: 100, high: 111, low: 99, close: 110 }, 5));
    expect(await sim.getPositions()).toHaveLength(0);
    const fills = await sim.getFills();
    expect(fills).toHaveLength(2); // entry + one exit, not three
    expect(sim.realizedPnl("qual-sphb")).toBeGreaterThan(0);
  });

  it("resolves a bar that spans both levels as a stop (pessimistic)", async () => {
    const sim = new Simulator();
    sim.onBar(bar("QUAL", { close: 100 }, 0));
    await sim.placeBracket(longReq());
    // Bar touches both stop (95) and target (110): stop must win.
    sim.onBar(bar("QUAL", { open: 100, high: 111, low: 94, close: 105 }, 5));
    expect(await sim.getPositions()).toHaveLength(0);
    expect(sim.realizedPnl("qual-sphb")).toBeLessThan(0);
  });

  it("models a gap-through stop below the stop price", async () => {
    const sim = new Simulator();
    sim.onBar(bar("QUAL", { close: 100 }, 0));
    await sim.placeBracket(longReq({ targetPrice: undefined }));
    sim.onBar(bar("QUAL", { open: 90, high: 91, low: 88, close: 89 }, 5));
    const [exit] = (await sim.getFills()).slice(-1);
    expect(exit.price).toBeLessThan(95); // filled at the gap, worse than the stop
  });

  it("shorts fill and stop out symmetrically", async () => {
    const sim = new Simulator();
    sim.onBar(bar("QUAL", { close: 100 }, 0));
    await sim.placeBracket(
      longReq({ side: "short", stopPrice: 105, targetPrice: 90 }),
    );
    sim.onBar(bar("QUAL", { open: 100, high: 106, low: 99, close: 104 }, 5));
    expect(await sim.getPositions()).toHaveLength(0);
    expect(sim.realizedPnl("qual-sphb")).toBeLessThan(0); // stopped for a loss
  });
});

describe("modify / cancel", () => {
  it("rejects an upward qty change (no averaging up)", async () => {
    const sim = new Simulator();
    sim.onBar(bar("QUAL", { close: 100 }));
    const h = await sim.placeBracket(longReq());
    await expect(
      sim.modifyBracket({ bracketId: h.bracketId, newQty: 200 }),
    ).rejects.toThrow(/downward-only/i);
  });

  it("scales out a partial quantity at market", async () => {
    const sim = new Simulator();
    sim.onBar(bar("QUAL", { close: 100 }));
    const h = await sim.placeBracket(longReq());
    await sim.modifyBracket({ bracketId: h.bracketId, newQty: 40 });
    const [pos] = await sim.getPositions();
    expect(pos.qty).toBe(40);
    expect((await sim.getFills()).length).toBe(2); // entry + partial exit
  });

  it("cancelling an open bracket flattens the position", async () => {
    const sim = new Simulator();
    sim.onBar(bar("QUAL", { close: 100 }));
    const h = await sim.placeBracket(longReq());
    await sim.cancelBracket(h.bracketId);
    expect(await sim.getPositions()).toHaveLength(0);
  });

  it("cancelling a pending bracket leaves no position and no fills", async () => {
    const sim = new Simulator();
    const h = await sim.placeBracket(longReq());
    await sim.cancelBracket(h.bracketId);
    sim.onBar(bar("QUAL", { close: 100 }));
    expect(await sim.getPositions()).toHaveLength(0);
    expect(await sim.getFills()).toHaveLength(0);
  });
});

describe("modify stop/target, fills, and lookups", () => {
  it("trails the stop and moves the target via modifyBracket", async () => {
    const sim = new Simulator();
    sim.onBar(bar("QUAL", { close: 100 }));
    const h = await sim.placeBracket(longReq());
    await sim.modifyBracket({ bracketId: h.bracketId, newStopPrice: 98 });
    // Old stop was 95; a bar to 97 must now trigger the trailed stop.
    sim.onBar(bar("QUAL", { open: 100, high: 100, low: 96, close: 97 }, 5));
    expect(await sim.getPositions()).toHaveLength(0);
    expect(sim.realizedPnl("qual-sphb")).toBeLessThan(0);
  });

  it("modifies the target and exits there", async () => {
    const sim = new Simulator();
    sim.onBar(bar("QUAL", { close: 100 }));
    const h = await sim.placeBracket(longReq());
    await sim.modifyBracket({ bracketId: h.bracketId, newTargetPrice: 103 });
    sim.onBar(bar("QUAL", { open: 100, high: 104, low: 99, close: 103 }, 5));
    expect(await sim.getPositions()).toHaveLength(0);
    expect(sim.realizedPnl("qual-sphb")).toBeGreaterThan(0);
  });

  it("filters getFills by the since cutoff", async () => {
    const sim = new Simulator();
    sim.onBar(bar("QUAL", { close: 100 }, 0));
    await sim.placeBracket(longReq());
    sim.onBar(bar("QUAL", { open: 100, high: 111, low: 99, close: 110 }, 5));
    expect(await sim.getFills()).toHaveLength(2);
    expect(await sim.getFills(min(3))).toHaveLength(1); // only the exit
  });

  it("throws on an unknown bracket id", async () => {
    const sim = new Simulator();
    await expect(sim.cancelBracket("nope")).rejects.toThrow(/unknown bracket/i);
  });

  it("cancel-flattens a short position", async () => {
    const sim = new Simulator();
    sim.onBar(bar("QUAL", { close: 100 }));
    const h = await sim.placeBracket(
      longReq({ side: "short", stopPrice: 105, targetPrice: 90 }),
    );
    await sim.cancelBracket(h.bracketId);
    expect(await sim.getPositions()).toHaveLength(0);
  });
});

describe("reset (AC: zeroes a portfolio and yields an audit record)", () => {
  it("restores starting cash and reports the prior state", async () => {
    const sim = new Simulator({ startingCash: 50_000 });
    sim.onBar(bar("QUAL", { close: 100 }));
    await sim.placeBracket(longReq());
    expect(sim.cash("qual-sphb")).toBeLessThan(50_000); // cash tied up
    const rec = sim.resetPortfolio("qual-sphb", min(99));
    expect(rec.openPositionsClosed).toBe(1);
    expect(rec.cashAfter).toBe(50_000);
    expect(rec.resetAt).toEqual(min(99));
    expect(sim.cash("qual-sphb")).toBe(50_000);
    expect(await sim.getPositions("qual-sphb")).toHaveLength(0);
  });
});

describe("AC: accounting balances to the cent across 1,000 random trades", () => {
  it("cash delta equals realized P&L when flat, exactly", async () => {
    const rand = mulberry32(0xc0ffee);
    const sim = new Simulator({ startingCash: 1_000_000 });
    const start = 1_000_000;

    for (let i = 0; i < 1000; i++) {
      const side = rand() < 0.5 ? "long" : "short";
      const entry = roundCents(20 + rand() * 180); // $20–$200
      const stopDist = roundCents(0.5 + rand() * 4);
      const tgtDist = roundCents(0.5 + rand() * 6);
      const stopPrice =
        side === "long"
          ? roundCents(entry - stopDist)
          : roundCents(entry + stopDist);
      const targetPrice =
        side === "long"
          ? roundCents(entry + tgtDist)
          : roundCents(entry - tgtDist);
      const qty = 1 + Math.floor(rand() * 200);

      // Seed a quote at the entry so the market order fills, then place.
      sim.onBar(bar("QUAL", { close: entry }, i * 2));
      await sim.placeBracket(
        longReq({ side, qty, stopPrice, targetPrice, ticker: "QUAL" }),
      );
      // Drive a bar that resolves the bracket one way or the other.
      const hitTarget = rand() < 0.5;
      const level = hitTarget ? targetPrice : stopPrice;
      sim.onBar(
        bar(
          "QUAL",
          {
            open: entry,
            high: Math.max(entry, level) + 0.5,
            low: Math.min(entry, level) - 0.5,
            close: level,
          },
          i * 2 + 1,
        ),
      );
      // Every position must be flat before the next trade opens.
      expect(await sim.getPositions()).toHaveLength(0);
    }

    // Flat book ⇒ cash moved by exactly the realized P&L, to the cent.
    const cash = sim.cash("qual-sphb");
    const realized = sim.realizedPnl("qual-sphb");
    expect(roundCents(cash - start)).toBe(roundCents(realized));
  });
});

describe("AC: property — a bracket closes on exactly one leg, never both", () => {
  it("over 500 random entries + random bar walks", async () => {
    const rand = mulberry32(0x5eed);
    for (let i = 0; i < 500; i++) {
      const sim = new Simulator();
      const side = rand() < 0.5 ? "long" : "short";
      const entry = roundCents(50 + rand() * 100);
      const stopDist = roundCents(0.5 + rand() * 3);
      const tgtDist = roundCents(0.5 + rand() * 3);
      const stopPrice =
        side === "long"
          ? roundCents(entry - stopDist)
          : roundCents(entry + stopDist);
      const targetPrice =
        side === "long"
          ? roundCents(entry + tgtDist)
          : roundCents(entry - tgtDist);

      sim.onBar(bar("QUAL", { close: entry }, 0));
      await sim.placeBracket(
        longReq({ side, qty: 10, stopPrice, targetPrice }),
      );

      // Random walk until the bracket closes (bounded).
      let price = entry;
      let closed = false;
      for (let step = 1; step <= 50 && !closed; step++) {
        const next = roundCents(price + (rand() - 0.5) * 6);
        const safe = Math.max(1, next);
        sim.onBar(
          bar(
            "QUAL",
            {
              open: price,
              high: Math.max(price, safe),
              low: Math.min(price, safe),
              close: safe,
            },
            step,
          ),
        );
        price = safe;
        closed = (await sim.getPositions()).length === 0;
      }

      if (closed) {
        // Exactly one entry fill and one exit fill — never two exits.
        expect(await sim.getFills()).toHaveLength(2);
      }
    }
  });
});

describe("drainClosedTrades (T3.4 governor input)", () => {
  it("emits a loss when a long is stopped out", async () => {
    const sim = new Simulator();
    sim.onBar(bar("QUAL", { close: 100 }, 0));
    await sim.placeBracket(longReq());
    sim.onBar(bar("QUAL", { open: 100, high: 101, low: 94, close: 96 }, 5));

    const closed = sim.drainClosedTrades();
    expect(closed).toHaveLength(1);
    expect(closed[0]!.strategyId).toBe("qual-sphb");
    expect(closed[0]!.ticker).toBe("QUAL");
    expect(closed[0]!.realizedPnl).toBeLessThan(0);
    // Draining consumes the buffer.
    expect(sim.drainClosedTrades()).toHaveLength(0);
  });

  it("emits a win when a long hits its target", async () => {
    const sim = new Simulator();
    sim.onBar(bar("QUAL", { close: 100 }, 0));
    await sim.placeBracket(longReq());
    sim.onBar(bar("QUAL", { open: 100, high: 111, low: 99, close: 110 }, 5));

    const closed = sim.drainClosedTrades();
    expect(closed).toHaveLength(1);
    expect(closed[0]!.realizedPnl).toBeGreaterThan(0);
  });

  it("drains only the requested strategy, leaving others buffered", async () => {
    const sim = new Simulator();
    sim.onBar(bar("QUAL", { close: 100 }, 0));
    await sim.placeBracket(longReq({ strategyId: "a" }));
    await sim.placeBracket(longReq({ strategyId: "b" }));
    sim.onBar(bar("QUAL", { open: 100, high: 101, low: 94, close: 96 }, 5));

    const a = sim.drainClosedTrades("a");
    expect(a.map((t) => t.strategyId)).toEqual(["a"]);
    // b is still buffered.
    const b = sim.drainClosedTrades("b");
    expect(b.map((t) => t.strategyId)).toEqual(["b"]);
    expect(sim.drainClosedTrades()).toHaveLength(0);
  });
});
