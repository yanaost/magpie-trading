/**
 * Signal pipeline module (T1.6). Wires the I/O-free {@link PipelineService} to
 * its Drizzle repositories, the shared SIM {@link Simulator}, and adapters over
 * the LLM analyst, kill switch, and WS gateway; then attaches the BullMQ
 * scan/monitor/expiry jobs.
 */
import { BullModule } from "@nestjs/bullmq";
import { Module } from "@nestjs/common";
import { AutoGovernor, Simulator } from "@magpie/core";
import type { TradeProposal } from "@magpie/core";
import { allStrategies } from "@magpie/strategies";
import { EventsModule } from "../ws/events.module.js";
import { TelegramModule } from "../telegram/telegram.module.js";
import { TelegramNotifier } from "../telegram/telegram.notifier.js";
import type { ProposalNotifier } from "./pipeline.types.js";
import { KillSwitchModule } from "../killswitch/killswitch.module.js";
import { LlmModule } from "../llm/llm.module.js";
import { QueueModule } from "../queue/queue.module.js";
import {
  AccountEquityService,
  BROKER_ACCOUNT_PORT,
  type BrokerAccountPort,
} from "./account-equity.service.js";
import {
  DbSimMarketContextProvider,
  FanoutAutoTradeNotifier,
  KillSwitchGateAdapter,
  LlmAnalystAdapter,
  SystemClock,
  SIMULATOR,
  STRATEGY_INSTANCES,
  WsProposalNotifier,
} from "./pipeline.providers.js";
import { crowdingProviders } from "../crowding/crowding.providers.js";
import { DrizzleCrowdingFilter } from "../crowding/drizzle-crowding-filter.js";
import { CrowdingRefreshService } from "../crowding/crowding-refresh.service.js";
import {
  executionProviders,
  MultiTargetExecutionPortProvider,
} from "../execution/execution.module.js";
import { InMemoryBracketIndex } from "./bracket-index.js";
import {
  PipelineProcessor,
  PipelineScheduler,
  PIPELINE_QUEUE,
} from "./pipeline.processor.js";
import {
  DrizzleJournalSink,
  DrizzlePipelineAuditSink,
  DrizzleAutoModeController,
  DrizzleProposalStore,
  DrizzleRiskEventStore,
  DrizzleSignalStore,
  DrizzleStrategyRegistry,
} from "./pipeline.repository.js";
import { PipelineService } from "./pipeline.service.js";
import {
  AUTO_GOVERNOR,
  AUTO_MODE_CONTROLLER,
  AUTO_TRADE_NOTIFIER,
  BRACKET_INDEX,
  CROWDING_FILTER,
  EXECUTION_PORT_PROVIDER,
  JOURNAL_SINK,
  KILL_SWITCH_GATE,
  LLM_ANALYST,
  MARKET_CONTEXT_PROVIDER,
  PIPELINE_AUDIT_SINK,
  PIPELINE_CLOCK,
  PROPOSAL_NOTIFIER,
  PROPOSAL_STORE,
  RISK_EVENT_STORE,
  SIGNAL_STORE,
  STRATEGY_REGISTRY,
} from "./pipeline.types.js";

@Module({
  imports: [
    QueueModule,
    LlmModule,
    KillSwitchModule,
    EventsModule,
    TelegramModule,
    BullModule.registerQueue({ name: PIPELINE_QUEUE }),
  ],
  providers: [
    PipelineService,
    PipelineProcessor,
    PipelineScheduler,
    // Strategy code instances joined to the `strategies` config rows by id (T1.7).
    { provide: STRATEGY_INSTANCES, useValue: allStrategies() },
    // The single in-process SIM execution port.
    { provide: SIMULATOR, useFactory: () => new Simulator() },
    // Ports → implementations.
    { provide: STRATEGY_REGISTRY, useClass: DrizzleStrategyRegistry },
    { provide: SIGNAL_STORE, useClass: DrizzleSignalStore },
    { provide: PROPOSAL_STORE, useClass: DrizzleProposalStore },
    { provide: RISK_EVENT_STORE, useClass: DrizzleRiskEventStore },
    { provide: JOURNAL_SINK, useClass: DrizzleJournalSink },
    { provide: PIPELINE_AUDIT_SINK, useClass: DrizzlePipelineAuditSink },
    { provide: LLM_ANALYST, useClass: LlmAnalystAdapter },
    { provide: KILL_SWITCH_GATE, useClass: KillSwitchGateAdapter },
    // Fan proposal notifications out to both the dashboard (WS) and Telegram.
    // Errors in either channel are isolated so one down channel can't block the
    // other or the pipeline.
    WsProposalNotifier,
    {
      provide: PROPOSAL_NOTIFIER,
      useFactory: (
        ws: WsProposalNotifier,
        tg: TelegramNotifier,
      ): ProposalNotifier => ({
        async proposalPending(p: TradeProposal & { id: string }) {
          await Promise.allSettled([
            ws.proposalPending(p),
            tg.proposalPending(p),
          ]);
        },
      }),
      inject: [WsProposalNotifier, TelegramNotifier],
    },
    // Strategy #6 (T2.4): DB-backed crowding filter + nightly refresh job.
    ...crowdingProviders,
    { provide: CROWDING_FILTER, useExisting: DrizzleCrowdingFilter },
    ...executionProviders,
    // Per-strategy equity resolution (A0): SIM virtual cash, else broker NLV.
    // The broker port is optional so a SIM-only wiring needs no IB connection.
    {
      provide: AccountEquityService,
      useFactory: (simulator: Simulator, broker: BrokerAccountPort | null) =>
        new AccountEquityService(simulator, broker),
      inject: [SIMULATOR, { token: BROKER_ACCOUNT_PORT, optional: true }],
    },
    { provide: MARKET_CONTEXT_PROVIDER, useClass: DbSimMarketContextProvider },
    {
      provide: EXECUTION_PORT_PROVIDER,
      useExisting: MultiTargetExecutionPortProvider,
    },
    { provide: BRACKET_INDEX, useClass: InMemoryBracketIndex },
    { provide: PIPELINE_CLOCK, useClass: SystemClock },
    // AUTO-mode hardening (T3.4): shared in-process governor (caps + cooldown),
    // the demotion writer, and the entry/exit/demotion notifier.
    { provide: AUTO_GOVERNOR, useFactory: () => new AutoGovernor() },
    { provide: AUTO_MODE_CONTROLLER, useClass: DrizzleAutoModeController },
    FanoutAutoTradeNotifier,
    { provide: AUTO_TRADE_NOTIFIER, useExisting: FanoutAutoTradeNotifier },
  ],
  exports: [
    PipelineService,
    SIMULATOR,
    EXECUTION_PORT_PROVIDER,
    BRACKET_INDEX,
    CrowdingRefreshService,
  ],
})
export class PipelineModule {}
