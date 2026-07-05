import { describe, expect, it } from "vitest";
import {
  DEFAULT_RISK_PARAMS,
  DEFAULT_PROPOSAL_TTL_MS,
  RiskManager,
  type ProposalDraft,
  type Position,
  type RiskContext,
  type RiskParams,
} from "./index.js";

const NOW = new Date("2026-07-05T14:00:00Z");
const EQUITY = 100_000;

/** A clean 2%-per-trade manager (loosest config within the ceilings). */
const mgr = new RiskManager({ ...DEFAULT_RISK_PARAMS, maxRiskPerTradePct: 2 });

/** A baseline long draft: entry 150, stop 147 → $3 stop distance. */
function draft(over: Partial<ProposalDraft> = {}): ProposalDraft {
  return {
    strategyId: "qual-sphb",
    ticker: "QUAL",
    side: "long",
    requestedQty: 1000,
    entry: 150,
    stop: 147,
    exitPlan: { stopLoss: 147, rules: [] },
    ...over,
  };
}

function ctx(over: Partial<RiskContext> = {}): RiskContext {
  return {
    now: NOW,
    equity: EQUITY,
    executionTarget: "SIM",
    openPositions: [],
    ...over,
  };
}

/** An open position helper for building the book. */
function pos(over: Partial<Position> = {}): Position {
  return {
    strategyId: "other",
    target: "SIM",
    ticker: "AAA",
    side: "long",
    status: "open",
    qty: 10,
    avgEntryPrice: 100,
    stopPrice: 98,
    realizedPnl: 0,
    unrealizedPnl: 0,
    openedAt: NOW,
    ...over,
  };
}

describe("RiskManager.evaluate — happy path & sizing", () => {
  it("sizes whole shares to the risk budget and stamps riskUsd/riskPct", () => {
    const d = mgr.evaluate(draft(), ctx());
    expect(d.approved).toBe(true);
    if (!d.approved) return;
    // budget = 2% * 100k = $2000; stop distance $3 → floor(666.6) = 666 shares
    expect(d.proposal.qty).toBe(666);
    expect(d.proposal.riskUsd).toBe(1998); // 666 * 3
    expect(d.proposal.riskPct).toBeCloseTo(1.998, 3);
    expect(d.proposal.status).toBe("pending");
    expect(d.proposal.executionTarget).toBe("SIM");
    expect(d.proposal.expiry.getTime()).toBe(
      NOW.getTime() + DEFAULT_PROPOSAL_TTL_MS,
    );
  });

  it("sizes a short correctly (stop above entry)", () => {
    const d = mgr.evaluate(
      draft({
        side: "short",
        entry: 100,
        stop: 102,
        exitPlan: { stopLoss: 102, rules: [] },
      }),
      ctx(),
    );
    expect(d.approved).toBe(true);
    if (!d.approved) return;
    expect(d.proposal.qty).toBe(1000); // budget 2000 / stop distance 2
  });
});

interface RejectCase {
  name: string;
  params?: Partial<RiskParams>;
  draft?: Partial<ProposalDraft>;
  ctx?: Partial<RiskContext>;
  rule: string;
  reasonMatch: RegExp;
  severity?: string;
}

const REJECTIONS: RejectCase[] = [
  {
    name: "kill switch active blocks everything",
    ctx: { killSwitchActive: true },
    rule: "kill_switch_active",
    reasonMatch: /Kill switch is active/,
    severity: "critical",
  },
  {
    name: "stop on wrong side for a long",
    draft: {
      side: "long",
      entry: 150,
      stop: 152,
      exitPlan: { stopLoss: 152, rules: [] },
    },
    rule: "invalid_stop",
    reasonMatch: /wrong side of entry/,
  },
  {
    name: "stop on wrong side for a short",
    draft: {
      side: "short",
      entry: 150,
      stop: 148,
      exitPlan: { stopLoss: 148, rules: [] },
    },
    rule: "invalid_stop",
    reasonMatch: /wrong side of entry/,
  },
  {
    name: "averaging down into same ticker/side/strategy",
    ctx: {
      openPositions: [
        pos({ strategyId: "qual-sphb", ticker: "QUAL", side: "long" }),
      ],
    },
    // per-ticker cap would also fire, but averaging-down is checked first
    rule: "no_averaging_down",
    reasonMatch: /averaging down is not allowed/,
  },
  {
    name: "max concurrent positions across the book",
    params: { maxPositionsPerStrategy: 5, maxPositionsPerTicker: 5 },
    ctx: {
      openPositions: [
        pos({ ticker: "A" }),
        pos({ ticker: "B" }),
        pos({ ticker: "C" }),
        pos({ ticker: "D" }),
        pos({ ticker: "E" }),
      ],
    },
    rule: "max_positions_total",
    reasonMatch: /Max concurrent positions reached \(5\/5\)/,
  },
  {
    name: "max positions per strategy",
    params: { maxPositionsPerTicker: 5 },
    ctx: {
      openPositions: [
        pos({ strategyId: "qual-sphb", ticker: "X" }),
        pos({ strategyId: "qual-sphb", ticker: "Y" }),
      ],
    },
    rule: "max_positions_per_strategy",
    reasonMatch: /Max positions for qual-sphb reached \(2\/2\)/,
  },
  {
    name: "max positions per ticker across strategies",
    params: { maxPositionsPerStrategy: 5 },
    ctx: {
      openPositions: [
        pos({ strategyId: "other", ticker: "QUAL", side: "short" }),
      ],
    },
    rule: "max_positions_per_ticker",
    reasonMatch: /Max positions in QUAL reached \(1\/1\)/,
  },
  {
    name: "stop too wide to size even one share",
    draft: { entry: 150, stop: 0.01, exitPlan: { stopLoss: 0.01, rules: [] } },
    params: { maxRiskPerTradePct: 0.001 },
    rule: "per_trade_risk",
    reasonMatch: /too wide to size ≥1 share/,
  },
  {
    name: "total open risk exceeds the 6% cap",
    params: { maxPositionsPerStrategy: 5, maxPositionsPerTicker: 5 },
    // existing position risks 5% ($5000: 2500 shares * $2), new trade ~2% → >6%
    ctx: {
      openPositions: [
        pos({ ticker: "ZZZ", qty: 2500, avgEntryPrice: 100, stopPrice: 98 }),
      ],
    },
    rule: "total_open_risk",
    reasonMatch: /Total open risk .* would exceed the 6% cap/,
  },
];

describe("RiskManager.evaluate — rejections (table-driven, exact reasons)", () => {
  it.each(REJECTIONS)(
    "$name → $rule",
    ({ name: _n, params, draft: d, ctx: c, rule, reasonMatch, severity }) => {
      const m = new RiskManager({
        ...DEFAULT_RISK_PARAMS,
        maxRiskPerTradePct: 2,
        ...params,
      });
      const decision = m.evaluate(draft(d), ctx(c));
      expect(decision.approved).toBe(false);
      if (decision.approved) return;
      expect(decision.event.rule).toBe(rule);
      expect(decision.event.reason).toMatch(reasonMatch);
      if (severity) expect(decision.event.severity).toBe(severity);
      expect(decision.event.strategyId).toBe("qual-sphb");
    },
  );
});

describe("RiskManager.evaluate — defensive non-finite stop", () => {
  it("rejects a non-finite stop even though the schema normally forbids it", () => {
    // bypass the ProposalDraft schema to exercise the defensive guard
    const bad = draft({ stop: Number.NaN as unknown as number });
    const d = mgr.evaluate(bad, ctx());
    expect(d.approved).toBe(false);
    if (d.approved) return;
    expect(d.event.rule).toBe("invalid_stop");
    expect(d.event.reason).toMatch(/mandatory/);
  });
});

describe("RiskManager — effective limits clamp to the globals (spec §5)", () => {
  it("clamps a config that tries to exceed a ceiling", () => {
    const m = new RiskManager({
      ...DEFAULT_RISK_PARAMS,
      // try to loosen well past the globals
      maxRiskPerTradePct: 10,
      maxConcurrentPositions: 50,
      maxTotalOpenRiskPct: 25,
    } as RiskParams);
    expect(m.limits.maxRiskPerTradePct).toBe(2);
    expect(m.limits.maxConcurrentPositions).toBe(5);
    expect(m.limits.maxTotalOpenRiskPct).toBe(6);
  });

  it("honors a config that tightens below the ceiling", () => {
    const m = new RiskManager({
      ...DEFAULT_RISK_PARAMS,
      maxRiskPerTradePct: 1,
    });
    expect(m.limits.maxRiskPerTradePct).toBe(1);
    const d = m.evaluate(draft(), ctx());
    expect(d.approved).toBe(true);
    if (!d.approved) return;
    expect(d.proposal.qty).toBe(333); // 1% * 100k / $3 = 333.3 → 333
  });
});

describe("RiskManager.checkDailyLoss — kill-switch trip at −3%", () => {
  it("does not trip above the limit (−2.9%)", () => {
    const r = mgr.checkDailyLoss(-2_900, EQUITY);
    expect(r.tripped).toBe(false);
    expect(r.event).toBeUndefined();
  });

  it("trips exactly at −3% with a critical event", () => {
    const r = mgr.checkDailyLoss(-3_000, EQUITY);
    expect(r.tripped).toBe(true);
    expect(r.event?.rule).toBe("daily_loss_limit");
    expect(r.event?.severity).toBe("critical");
    expect(r.event?.reason).toMatch(/-3% daily loss limit/);
  });

  it("trips below the limit (−5%)", () => {
    expect(mgr.checkDailyLoss(-5_000, EQUITY).tripped).toBe(true);
  });

  it("does not trip on a profitable day", () => {
    expect(mgr.checkDailyLoss(5_000, EQUITY).tripped).toBe(false);
  });
});
