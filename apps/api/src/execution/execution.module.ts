/**
 * Execution wiring (T2.1). Replaces the SIM-only port provider with a
 * multi-target one that routes SIM → the in-process {@link Simulator}, PAPER →
 * a lazily-connected {@link IbExecutionPort}, and LIVE → a hard
 * {@link LivePromotionLockedError} (ground rule 6). The IB gateway is built and
 * connected only the first time a PAPER order is requested, so a SIM-only boot
 * (the default) never touches the broker socket.
 */
import { Inject, Injectable } from "@nestjs/common";
import {
  LivePromotionLockedError,
  Simulator,
  type ExecutionPort,
  type ExecutionTarget,
} from "@magpie/core";
import { APP_CONFIG, type AppConfig } from "../config/env.schema.js";
import { SIMULATOR } from "../pipeline/pipeline.providers.js";
import {
  BROKER_ACCOUNT_PORT,
  type BrokerAccountPort,
} from "../pipeline/account-equity.service.js";
import type { ExecutionPortProvider } from "../pipeline/pipeline.types.js";
import { IbExecutionPort } from "./ib-execution-port.js";
import {
  IbApiOrderGateway,
  type IbOrderApiFactory,
} from "./ib-order-gateway.js";
import { createIbOrderApi } from "./ib-order-client-factory.js";

/** Injectable factory token so tests can supply a fake IB order client. */
export const IB_ORDER_API_FACTORY = Symbol("IB_ORDER_API_FACTORY");

/**
 * Routes each execution target to its port. SIM is always ready; PAPER is
 * connected on first use; LIVE always throws.
 */
@Injectable()
export class MultiTargetExecutionPortProvider
  implements ExecutionPortProvider, BrokerAccountPort
{
  private ibPort: IbExecutionPort | null = null;
  private ibGateway: IbApiOrderGateway | null = null;

  constructor(
    @Inject(SIMULATOR) private readonly simulator: Simulator,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(IB_ORDER_API_FACTORY) private readonly ibFactory: IbOrderApiFactory,
  ) {}

  portFor(target: ExecutionTarget): ExecutionPort {
    switch (target) {
      case "SIM":
        return this.simulator;
      case "PAPER":
        return this.paperPort();
      case "LIVE":
        // Rule 6: LIVE is locked in code until a deliberate future milestone.
        throw new LivePromotionLockedError(
          "no execution port is wired for LIVE",
        );
      default:
        throw new Error(`unknown execution target ${String(target)}`);
    }
  }

  /**
   * Broker-reported net liquidation value for PAPER/LIVE risk sizing (A0).
   * Reuses the lazily-built paper gateway, connecting it on first use so a
   * SIM-only boot never opens the broker socket.
   */
  async netLiquidationValue(): Promise<number> {
    const gateway = this.buildGateway();
    if (!gateway.isConnected()) await gateway.connect();
    return gateway.fetchNetLiquidation();
  }

  /** The IB order gateway, built once (no socket until {@link connect}). */
  private buildGateway(): IbApiOrderGateway {
    if (this.ibGateway) return this.ibGateway;
    this.ibGateway = new IbApiOrderGateway({
      host: this.config.IB_GATEWAY_HOST,
      port: this.config.IB_GATEWAY_PORT,
      // Distinct client id from the market-data connection to avoid a clash.
      clientId: this.config.IB_CLIENT_ID + 1,
      factory: this.ibFactory,
    });
    return this.ibGateway;
  }

  /** The IB paper port, built + connected lazily on first PAPER order. */
  private paperPort(): IbExecutionPort {
    if (this.ibPort) return this.ibPort;
    this.ibPort = new IbExecutionPort(this.buildGateway());
    return this.ibPort;
  }
}

/** DI providers for the execution layer. */
export const executionProviders = [
  { provide: IB_ORDER_API_FACTORY, useValue: createIbOrderApi },
  MultiTargetExecutionPortProvider,
  // The same provider answers PAPER/LIVE net-liquidation for risk sizing (A0).
  {
    provide: BROKER_ACCOUNT_PORT,
    useExisting: MultiTargetExecutionPortProvider,
  },
];
