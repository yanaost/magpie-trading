/**
 * Signal pipeline module (T1.6). Wires the I/O-free {@link PipelineService} to
 * its Drizzle repositories, the shared SIM {@link Simulator}, and adapters over
 * the LLM analyst, kill switch, and WS gateway; then attaches the BullMQ
 * scan/monitor/expiry jobs.
 */
import { BullModule } from "@nestjs/bullmq";
import { Module } from "@nestjs/common";
import { Simulator } from "@magpie/core";
import { EventsModule } from "../ws/events.module.js";
import { KillSwitchModule } from "../killswitch/killswitch.module.js";
import { LlmModule } from "../llm/llm.module.js";
import { QueueModule } from "../queue/queue.module.js";
import {
  DbSimMarketContextProvider,
  KillSwitchGateAdapter,
  LlmAnalystAdapter,
  NoopCrowdingFilter,
  SimExecutionPortProvider,
  SystemClock,
  SIMULATOR,
  STRATEGY_INSTANCES,
  WsProposalNotifier,
} from "./pipeline.providers.js";
import { InMemoryBracketIndex } from "./bracket-index.js";
import {
  PipelineProcessor,
  PipelineScheduler,
  PIPELINE_QUEUE,
} from "./pipeline.processor.js";
import {
  DrizzleJournalSink,
  DrizzlePipelineAuditSink,
  DrizzleProposalStore,
  DrizzleRiskEventStore,
  DrizzleSignalStore,
  DrizzleStrategyRegistry,
} from "./pipeline.repository.js";
import { PipelineService } from "./pipeline.service.js";
import {
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
    BullModule.registerQueue({ name: PIPELINE_QUEUE }),
  ],
  providers: [
    PipelineService,
    PipelineProcessor,
    PipelineScheduler,
    // Strategy code instances — empty until strategy #3 registers (T1.7).
    { provide: STRATEGY_INSTANCES, useValue: [] },
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
    { provide: PROPOSAL_NOTIFIER, useClass: WsProposalNotifier },
    { provide: CROWDING_FILTER, useClass: NoopCrowdingFilter },
    { provide: MARKET_CONTEXT_PROVIDER, useClass: DbSimMarketContextProvider },
    { provide: EXECUTION_PORT_PROVIDER, useClass: SimExecutionPortProvider },
    { provide: BRACKET_INDEX, useClass: InMemoryBracketIndex },
    { provide: PIPELINE_CLOCK, useClass: SystemClock },
  ],
  exports: [PipelineService, SIMULATOR, EXECUTION_PORT_PROVIDER, BRACKET_INDEX],
})
export class PipelineModule {}
