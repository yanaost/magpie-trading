/**
 * Deterministic signal-context hashing for the replay engine (T3.1).
 *
 * Two jobs, one hash:
 *   1. **Cache key** — "serve the LLM from `llm_analyses` when the same signal
 *      context exists". Two signals with identical `(strategyId, ticker, trigger,
 *      quantMetrics)` hash the same, so a prior analysis can be replayed instead
 *      of calling the model.
 *   2. **Stub seed** — on a cache miss the engine synthesizes a proceed/veto by
 *      pass-rate. Seeding that choice from the *context hash* (not a clock or
 *      RNG) keeps replay deterministic: the same signal always stubs the same
 *      way, so replaying a day twice yields identical trades (T3.1 AC).
 *
 * The hash is FNV-1a over a canonical JSON encoding with sorted object keys, so
 * key order in the trigger/metrics bags never changes the result.
 */

/** The signal fields that define its "context" for caching/stubbing. */
export interface SignalContext {
  readonly strategyId: string;
  readonly ticker: string;
  readonly trigger: Record<string, unknown>;
  readonly quantMetrics: Record<string, number>;
}

/**
 * Canonical JSON with recursively sorted object keys, so `{a:1,b:2}` and
 * `{b:2,a:1}` serialize identically. Arrays keep their order (it is meaningful).
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const body = keys
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
    .join(",");
  return `{${body}}`;
}

/** 32-bit FNV-1a over a UTF-16 code-unit stream, returned as 8 hex chars. */
export function fnv1a(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    // h *= 16777619, kept in 32-bit unsigned range via Math.imul.
    h = Math.imul(h, 0x01000193);
  }
  // >>> 0 coerces to unsigned; pad to a stable 8-char hex string.
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** Stable content hash of a signal's context (the cache key). */
export function signalContextHash(ctx: SignalContext): string {
  return fnv1a(
    canonicalJson({
      strategyId: ctx.strategyId,
      ticker: ctx.ticker,
      trigger: ctx.trigger,
      quantMetrics: ctx.quantMetrics,
    }),
  );
}

/**
 * Map a context hash to a stable value in [0, 1) — the deterministic draw the
 * pass-rate stub compares against. `verdict = draw < passRate ? proceed : veto`.
 */
export function hashUnitInterval(hash: string): number {
  // The 8 hex chars are a 32-bit integer; divide by 2^32 for [0, 1).
  const n = parseInt(hash.slice(0, 8), 16);
  return n / 0x1_0000_0000;
}

/** The fields of an analysis request that define "the same question asked". */
export interface AnalysisContext {
  readonly strategyId: string;
  readonly ticker: string;
  readonly prompt: string;
  readonly context: Record<string, unknown>;
  readonly requiredChecks: readonly string[];
  readonly webSearch: boolean;
}

/**
 * Content hash of an analysis request — the cache key for "serve the LLM from
 * `llm_analyses` when the same signal context exists". Identical questions
 * (same strategy, ticker, prompt, context, checks) hash identically regardless
 * of key order, so a prior verdict can be replayed instead of re-calling Claude.
 */
export function analysisContextHash(req: AnalysisContext): string {
  return fnv1a(
    canonicalJson({
      strategyId: req.strategyId,
      ticker: req.ticker,
      prompt: req.prompt,
      context: req.context,
      requiredChecks: [...req.requiredChecks],
      webSearch: req.webSearch,
    }),
  );
}
