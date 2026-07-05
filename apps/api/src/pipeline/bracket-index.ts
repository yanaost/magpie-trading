/**
 * In-process position→bracket index. SIM brackets live in the Simulator's
 * memory and the emitted `Position` carries no bracket id, so the pipeline
 * records the mapping when it opens a position and looks it up when the monitor
 * needs to modify/cancel. "No averaging down" (risk rule) guarantees at most one
 * open bracket per `strategyId:ticker`, so a flat map is sufficient.
 *
 * This is intentionally in-memory to match the in-process SIM execution rung;
 * once orders/fills are persisted and reconciled, a Drizzle-backed resolver can
 * replace it behind the same {@link BracketIndex} port.
 */
import { Injectable } from "@nestjs/common";
import type { Ticker } from "@magpie/core";
import type { BracketIndex } from "./pipeline.types.js";

@Injectable()
export class InMemoryBracketIndex implements BracketIndex {
  private readonly map = new Map<string, string>();

  private key(strategyId: string, ticker: Ticker): string {
    return `${strategyId}:${ticker}`;
  }

  record(strategyId: string, ticker: Ticker, bracketId: string): void {
    this.map.set(this.key(strategyId, ticker), bracketId);
  }

  resolve(strategyId: string, ticker: Ticker): string | undefined {
    return this.map.get(this.key(strategyId, ticker));
  }

  clear(strategyId: string, ticker: Ticker): void {
    this.map.delete(this.key(strategyId, ticker));
  }
}
