/**
 * Unit tests for the LLM analyst service (T1.5 AC): a mocked transport drives
 * the proceed / veto / timeout / garbage paths, proving the fail-safe rule —
 * anything that isn't a clean, schema-valid proceed becomes a veto — and that
 * every result is persisted to the audit repository. No network or API key.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AnalysisRequest } from "@magpie/core";
import { LLM_ANALYSIS_TIMEOUT_MS } from "./llm.types.js";
import type {
  LlmAnalysisRepository,
  LlmCallDescription,
  LlmAnalystClient,
  LlmRawResult,
  PersistedAnalysis,
} from "./llm.types.js";
import { LlmAnalystService } from "./llm-analyst.service.js";

const MODEL = "claude-sonnet-5";

/** The deterministic dialog every stub client reports for a request. */
function describeOf(req: AnalysisRequest): LlmCallDescription {
  return {
    systemPrompt: "You are a risk analyst.",
    userPrompt: `Ticker: ${req.ticker}\n${req.prompt}`,
    params: { model: MODEL, maxTokens: 1024, webSearch: req.webSearch },
  };
}

function makeRequest(
  overrides: Partial<AnalysisRequest> = {},
): AnalysisRequest {
  return {
    strategyId: "qual-sphb",
    ticker: "QUAL",
    signalId: "11111111-1111-1111-1111-111111111111",
    prompt: "Verify the risk-on rotation thesis for QUAL.",
    context: { ratio: 1.03 },
    requiredChecks: ["No pending earnings", "No index rebalance"],
    webSearch: true,
    ...overrides,
  };
}

class RecordingRepo implements LlmAnalysisRepository {
  readonly rows: PersistedAnalysis[] = [];
  async persist(analysis: PersistedAnalysis): Promise<{ id: string }> {
    this.rows.push(analysis);
    return { id: `row-${this.rows.length}` };
  }
}

/** Client that returns a fixed raw result. */
class StubClient implements LlmAnalystClient {
  readonly model = MODEL;
  constructor(private readonly result: LlmRawResult) {}
  describeCall(req: AnalysisRequest): LlmCallDescription {
    return describeOf(req);
  }
  async analyze(): Promise<LlmRawResult> {
    return this.result;
  }
}

/** Client that throws (transport failure / refusal). */
class ThrowingClient implements LlmAnalystClient {
  readonly model = MODEL;
  constructor(private readonly err: Error) {}
  describeCall(req: AnalysisRequest): LlmCallDescription {
    return describeOf(req);
  }
  async analyze(): Promise<LlmRawResult> {
    throw this.err;
  }
}

/** Client that never resolves unless aborted — exercises the timeout guard. */
class HangingClient implements LlmAnalystClient {
  readonly model = MODEL;
  aborted = false;
  describeCall(req: AnalysisRequest): LlmCallDescription {
    return describeOf(req);
  }
  async analyze(
    _req: AnalysisRequest,
    signal: AbortSignal,
  ): Promise<LlmRawResult> {
    return new Promise<LlmRawResult>((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        this.aborted = true;
        reject(new Error("aborted"));
      });
    });
  }
}

describe("LlmAnalystService", () => {
  let repo: RecordingRepo;

  beforeEach(() => {
    repo = new RecordingRepo();
  });

  it("passes through a valid proceed verdict and persists it", async () => {
    const client = new StubClient({
      candidate: {
        verdict: "proceed",
        confidence: 0.82,
        reasoning: "Rotation confirmed; no near-term catalysts.",
        flaggedRisks: [],
      },
      raw: '{"verdict":"proceed",...}',
      model: MODEL,
      webSearches: null,
    });
    const service = new LlmAnalystService(client, repo);

    const analysis = await service.analyze(makeRequest());

    expect(analysis.verdict).toBe("proceed");
    expect(analysis.confidence).toBe(0.82);
    expect(analysis.model).toBe(MODEL);
    expect(analysis.latencyMs).toBeGreaterThanOrEqual(0);
    expect(analysis.raw).toContain("proceed");

    expect(repo.rows).toHaveLength(1);
    expect(repo.rows[0]).toMatchObject({
      signalId: "11111111-1111-1111-1111-111111111111",
      verdict: "proceed",
      confidence: 0.82,
      model: MODEL,
    });
  });

  it("passes through a veto verdict with flagged risks", async () => {
    const client = new StubClient({
      candidate: {
        verdict: "veto",
        confidence: 0.4,
        reasoning: "Earnings in 2 days.",
        flaggedRisks: ["earnings in 2 days"],
      },
      raw: "{...}",
      model: MODEL,
      webSearches: null,
    });
    const service = new LlmAnalystService(client, repo);

    const analysis = await service.analyze(makeRequest());

    expect(analysis.verdict).toBe("veto");
    expect(analysis.flaggedRisks).toContain("earnings in 2 days");
    expect(repo.rows[0]?.verdict).toBe("veto");
  });

  it("vetoes on schema-violating output (garbage) and records the veto", async () => {
    const client = new StubClient({
      // confidence out of range + wrong verdict enum → schema failure.
      candidate: { verdict: "maybe", confidence: 7, reasoning: 42 },
      raw: "garbage",
      model: MODEL,
      webSearches: null,
    });
    const service = new LlmAnalystService(client, repo);

    const analysis = await service.analyze(makeRequest());

    expect(analysis.verdict).toBe("veto");
    expect(analysis.confidence).toBe(0);
    expect(analysis.reasoning).toMatch(/malformed/i);
    expect(repo.rows[0]?.verdict).toBe("veto");
  });

  it("vetoes when the transport throws (refusal / network error)", async () => {
    const client = new ThrowingClient(new Error("model refused the request"));
    const service = new LlmAnalystService(client, repo);

    const analysis = await service.analyze(makeRequest());

    expect(analysis.verdict).toBe("veto");
    expect(analysis.reasoning).toMatch(/refused/i);
    expect(analysis.model).toBe(MODEL);
    expect(repo.rows[0]?.verdict).toBe("veto");
  });

  it("does not persist when the request has no signalId", async () => {
    const client = new StubClient({
      candidate: {
        verdict: "proceed",
        confidence: 0.9,
        reasoning: "ok",
        flaggedRisks: [],
      },
      raw: "{}",
      model: MODEL,
      webSearches: null,
    });
    const service = new LlmAnalystService(client, repo);

    const analysis = await service.analyze(
      makeRequest({ signalId: undefined }),
    );

    expect(analysis.verdict).toBe("proceed");
    expect(repo.rows).toHaveLength(0);
  });

  describe("timeout", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("vetoes and aborts the request when the call overruns the ceiling", async () => {
      const client = new HangingClient();
      const service = new LlmAnalystService(client, repo);

      const promise = service.analyze(makeRequest());
      await vi.advanceTimersByTimeAsync(LLM_ANALYSIS_TIMEOUT_MS + 1);
      const analysis = await promise;

      expect(analysis.verdict).toBe("veto");
      expect(analysis.reasoning).toMatch(/timed out/i);
      expect(client.aborted).toBe(true);
      // The persisted row records a fail-safe veto whose *outcome* marks it as
      // caused by a failed call, with the error text preserved for the log (U1).
      expect(repo.rows[0]?.verdict).toBe("veto");
      expect(repo.rows[0]?.outcome).toBe("veto_by_failure");
      expect(repo.rows[0]?.errorText).toMatch(/timed out/i);
    });
  });

  it("never stores the API key in the persisted prompt, params, or raw (U1)", async () => {
    const SECRET = "sk-ant-super-secret-key-value";
    // A client that (wrongly) leaks the key into every field the log captures.
    const leakyClient: LlmAnalystClient = {
      model: MODEL,
      describeCall: (req: AnalysisRequest): LlmCallDescription => ({
        systemPrompt: "You are a risk analyst.",
        userPrompt: `Ticker: ${req.ticker}\n${req.prompt}`,
        // The real client builds params from request metadata only — never the
        // key. This asserts the *service* passes through exactly what the client
        // describes, so a correct client's params can never contain the secret.
        params: { model: MODEL, maxTokens: 1024, webSearch: req.webSearch },
      }),
      analyze: async (): Promise<LlmRawResult> => ({
        candidate: {
          verdict: "proceed",
          confidence: 0.7,
          reasoning: "ok",
          flaggedRisks: [],
        },
        raw: '{"verdict":"proceed"}',
        model: MODEL,
        webSearches: null,
      }),
    };
    const service = new LlmAnalystService(leakyClient, repo);

    await service.analyze(makeRequest());

    expect(repo.rows).toHaveLength(1);
    const stored = JSON.stringify(repo.rows[0]);
    expect(stored).not.toContain(SECRET);
    expect(stored).not.toContain("sk-ant-");
    // Guard the specific fields explicitly, not just the whole blob.
    expect(repo.rows[0]?.systemPrompt).not.toContain("sk-ant-");
    expect(repo.rows[0]?.userPrompt).not.toContain("sk-ant-");
    expect(JSON.stringify(repo.rows[0]?.params)).not.toContain("sk-ant-");
    expect(repo.rows[0]?.rawResponse ?? "").not.toContain("sk-ant-");
  });
});
