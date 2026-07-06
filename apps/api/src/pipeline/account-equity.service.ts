/**
 * Account equity resolution for risk sizing (A0). Every position size flows from
 * this number (RiskManager: `riskBudgetUsd = equity * maxRiskPerTradePct / 100`),
 * so it must reflect *real* buying power per target — not a fixed constant:
 *
 *   - SIM   → the strategy instance's virtual cash in the in-process
 *             {@link Simulator}. This tracks realized wins and losses, so a
 *             strategy that has drawn its account down sizes smaller, and one
 *             that has grown it sizes larger — exactly like a live account.
 *   - PAPER → the broker-reported net liquidation value (cash + marked
 *             positions) via a {@link BrokerAccountPort}. Wired lazily; a
 *             SIM-only boot never needs a broker connection.
 *   - LIVE  → same broker path (locked elsewhere until promotion; ground rule 6).
 *
 * Kept as a plain class (wired via `useFactory`, not `@Injectable`) so it takes
 * the `SIMULATOR` token and the optional broker port without importing the
 * former — that would form a circular module load with `pipeline.providers`.
 */
import type { ExecutionTarget, Simulator } from "@magpie/core";

/** DI token for the broker-side net-liquidation source (PAPER/LIVE equity). */
export const BROKER_ACCOUNT_PORT = Symbol("BROKER_ACCOUNT_PORT");

/** A broker account's reported equity, for sizing PAPER/LIVE trades. */
export interface BrokerAccountPort {
  /** Net liquidation value (cash + marked positions), account currency USD. */
  netLiquidationValue(): Promise<number>;
}

/** Resolves the equity to size against for a given execution target. */
export class AccountEquityService {
  constructor(
    private readonly simulator: Pick<Simulator, "cash">,
    private readonly broker: BrokerAccountPort | null,
  ) {}

  async equityFor(
    target: ExecutionTarget,
    strategyId: string,
  ): Promise<number> {
    if (target === "SIM") {
      // Per-strategy virtual cash: falls back to starting cash before the first
      // fill, then tracks realized P&L as trades close.
      return this.simulator.cash(strategyId);
    }
    if (!this.broker) {
      throw new Error(
        `no broker account source wired for ${target} equity; ` +
          "PAPER/LIVE sizing needs a connected IB account",
      );
    }
    return this.broker.netLiquidationValue();
  }
}
