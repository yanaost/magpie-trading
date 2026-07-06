/**
 * Short-interest port for strategy #4 (squeeze scalp, T3.3).
 *
 * A squeeze needs fuel: names with heavy short interest (>20% of float). That
 * data isn't in the broker feed — it's pulled nightly from an external source (a
 * Finviz-style screener export or a data API) into this port. A real adapter in
 * production; a {@link StaticShortInterestProvider} seeded from fixtures in tests
 * and replay. The strategy consumes the already-filtered high-SI roster and never
 * touches the network.
 */
import type { Ticker } from "@magpie/core";

/** One name's short-interest reading from the nightly ingest. */
export interface ShortInterestDatum {
  /** Symbol. */
  readonly ticker: Ticker;
  /** Short interest as a fraction of float (0.25 = 25% of float short). */
  readonly shortInterestPctFloat: number;
  /** Days-to-cover (short interest / avg daily volume), when known. */
  readonly daysToCover?: number;
  /** As-of date of the reading, ISO calendar date (YYYY-MM-DD). */
  readonly asOf: string;
}

/** Threshold config for what counts as a squeezable name. */
export interface ShortInterestParams {
  /** Minimum short interest as a fraction of float (spec: 0.20 = >20%). */
  readonly minShortInterestPctFloat: number;
}

export const DEFAULT_SHORT_INTEREST_PARAMS: ShortInterestParams = Object.freeze(
  {
    minShortInterestPctFloat: 0.2,
  },
);

/** Supplies the heavily-shorted names to hunt for a catalyst breakout. */
export interface ShortInterestProvider {
  /**
   * Names at or above the short-interest threshold as of `asOf`.
   * @param asOf - logical "now" for the run
   */
  highShortInterest(asOf: Date): Promise<ShortInterestDatum[]>;
}

/**
 * Fixture/config-backed provider: a fixed roster filtered to the high-SI band.
 * Deterministic — the registry default (empty until the nightly ingest is wired
 * in) and the fixtures tests seed.
 */
export class StaticShortInterestProvider implements ShortInterestProvider {
  private readonly all: readonly ShortInterestDatum[];
  private readonly params: ShortInterestParams;

  constructor(
    data: readonly ShortInterestDatum[] = [],
    params: Partial<ShortInterestParams> = {},
  ) {
    this.all = [...data];
    this.params = { ...DEFAULT_SHORT_INTEREST_PARAMS, ...params };
  }

  async highShortInterest(): Promise<ShortInterestDatum[]> {
    const { minShortInterestPctFloat } = this.params;
    return this.all
      .filter((d) => d.shortInterestPctFloat >= minShortInterestPctFloat)
      .sort((a, b) => (a.ticker < b.ticker ? -1 : a.ticker > b.ticker ? 1 : 0));
  }
}
