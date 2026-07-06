/**
 * Deterministic clock for replay (T3.1). The whole pipeline reads "now" only
 * through the {@link Clock} port; in replay we bind that port to this clock and
 * advance it by hand to each bar's timestamp, so every `contextFor(now)`, TTL
 * sweep, and proposal expiry sees *simulated* time. No wall-clock reads happen
 * on the money path, which is what makes "replay the same day twice → identical
 * trades" hold.
 */
import { Injectable } from "@nestjs/common";
import type { Clock } from "../pipeline/pipeline.types.js";

@Injectable()
export class ReplayClock implements Clock {
  private current: Date;

  /**
   * @param start - the simulated time the clock reports until first advanced.
   *   Defaults to the Unix epoch so an un-set clock is obvious in logs.
   */
  constructor(start: Date = new Date(0)) {
    this.current = start;
  }

  now(): Date {
    return this.current;
  }

  /** Advance (or set) simulated time to `at`. */
  set(at: Date): void {
    this.current = at;
  }
}
