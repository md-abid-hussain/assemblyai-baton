import "server-only";

import type OpenAI from "openai";
import { APIConnectionTimeoutError, APIError, APIUserAbortError, RateLimitError } from "openai";

import type { NewFactEvent } from "../../core/contracts/case";
import { BatonError, type ErrorCode } from "../../core/contracts/errors";
import { RawPatchEventSchema, type ExtractTurnInput, type ExtractTurnOutput, type RawPatch, type RawPatchEvent } from "../../core/contracts/extract";
import type { Extractor } from "../../core/contracts/services";
import type { TurnInput } from "../../core/contracts/turns";
import type { CaseEngine } from "../cases/engine";
import { log } from "../log";
import { extractStructured, IncompleteError, RefusalError, type OnTrace, type Usage } from "./client";

/**
 * The `gpt-6-luna` JSON-patch extractor (DESIGN §5.3; `Extractor`, TASKS §2). Never called inside a DB transaction.
 *
 * - Call: `extractStructured` with luna, effort "none", temperature 0, `max_output_tokens` 1000, store false,
 *   instructions = EXTRACTOR_PROMPT_V3, strict `add_driver_patch` schema, user input = §5.3 JSON (engine-built).
 * - Budget: `timeoutMs = 1500 + maxOutputTokens / 150 × 1000` (≈8.2 s at 1000 tokens; 10d: ≈166 tok/s, TTFT ≈1.17 s).
 *   SDK retries are off; this class retries itself.
 * - Retry: ONCE, with only the NEWEST turn as NEW TURNS (the older ones move into RECENT) and the same timeout, on a
 *   timeout, `status:"incomplete"`, 429/5xx/connection errors or unparseable output. A refusal is not retried.
 * - Output: events after the engine's §5.3 post-processing (no `seq`), plus WP3 bookkeeping (`coveredTurnIds`,
 *   `failedTurnIds`, `attempts`, `usd`, `error`). An upstream failure never throws: the turns come back as failed.
 */

/** luna list price, $ per 1M tokens (DESIGN §7.1). */
export const LUNA_USD_PER_M = { input: 0.1, output: 0.5 } as const;
export const EXTRACT_MAX_OUTPUT_TOKENS = 1000;
export const extractTimeoutMs = (maxOutputTokens = EXTRACT_MAX_OUTPUT_TOKENS): number => Math.ceil(1500 + (maxOutputTokens / 150) * 1000);

export interface ExtractTurnResult extends ExtractTurnOutput {
  /** Turn ids whose events are in `events` (all new turns, or only the newest after a retry). */
  coveredTurnIds: string[];
  /** Turn ids that were not extracted (final failure, or dropped by the newest-turn retry). */
  failedTurnIds: string[];
  attempts: number;
  usd: number;
  /** Last upstream error, when any attempt failed. */
  error: { code: ErrorCode; message: string } | null;
  /** `no_facts` of the accepted patch. */
  noFacts: boolean;
}

/** The slice of `CaseEngine` one extraction needs: the prompt/schema pin, the input builder and the post-processing. */
export type ExtractorEngine = Pick<CaseEngine, "applyExtraction" | "buildExtractorInput" | "extractor">;

/**
 * WP14b·3: the engine of the case's relay version rides as an OPTIONAL extra key on the input. `ExtractTurnInput`
 * is frozen v1 (contracts/extract.ts), and widening a parameter keeps this class assignable to the `Extractor` port,
 * so one extractor instance serves every relay. `ExtractService` resolves it once per batch from
 * `cases.relay_version_id`; omitted (a Baton case, or a caller that predates this), the constructor's engine is used
 * and the behaviour is byte-identical to before.
 */
export type RelayExtractTurnInput = ExtractTurnInput & { engine?: ExtractorEngine };

export interface OpenAIExtractorOptions {
  /** An OpenAI client, or a lazy factory (the key is read only when the first turn arrives). */
  client: OpenAI | (() => OpenAI);
  /** The default (flagship) engine: used whenever an input carries no per-case `engine`. */
  engine: ExtractorEngine;
  maxOutputTokens?: number;
  /** Override the computed budget (tests). */
  timeoutMs?: number;
  /** Delay before the retry after a 429 (ms, capped by Retry-After). */
  rateRetryDelayMs?: number;
  onTrace?: OnTrace;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

type Attempt =
  | { ok: true; patch: RawPatch; usage: Usage; ms: number; dropped: number }
  | { ok: false; code: ErrorCode; message: string; retry: boolean; usage: Usage | null; ms: number; retryAfterMs?: number };

const exLog = log.child({ component: "extractor" });
const zeroUsage: Usage = { input_tokens: 0, output_tokens: 0, reasoning_tokens: 0, cached_tokens: 0 };

export const usdOfUsage = (u: Usage): number => (u.input_tokens * LUNA_USD_PER_M.input + u.output_tokens * LUNA_USD_PER_M.output) / 1e6;

/** Keep the valid events of a patch (the strict schema makes this a no-op in practice; a bad item never sinks the rest). */
export function sanitizePatch(data: unknown): { patch: RawPatch; dropped: number } | null {
  if (!data || typeof data !== "object") return null;
  const d = data as { events?: unknown; no_facts?: unknown };
  if (!Array.isArray(d.events)) return null;
  const events: RawPatchEvent[] = [];
  let dropped = 0;
  for (const e of d.events) {
    const r = RawPatchEventSchema.safeParse(e);
    if (r.success) events.push(r.data);
    else dropped++;
  }
  return { patch: { no_facts: d.no_facts === true, events }, dropped };
}

export class OpenAIExtractor implements Extractor {
  private clientInst: OpenAI | null;
  private readonly o: OpenAIExtractorOptions;

  constructor(o: OpenAIExtractorOptions) {
    this.o = o;
    this.clientInst = typeof o.client === "function" ? null : o.client;
  }

  private client(): OpenAI {
    if (!this.clientInst) this.clientInst = (this.o.client as () => OpenAI)();
    return this.clientInst;
  }

  get timeoutMs(): number {
    return this.o.timeoutMs ?? extractTimeoutMs(this.o.maxOutputTokens);
  }

  async extractTurn(input: RelayExtractTurnInput): Promise<ExtractTurnResult> {
    const now = this.o.now ?? (() => performance.now());
    const t0 = now();
    const eng = input.engine ?? this.o.engine;
    const art = eng.extractor;
    const newTurns = [...input.newTurns].sort((a, b) => a.endMs - b.endMs || a.recvMs - b.recvMs);
    const usage = { input: 0, output: 0 };
    let usd = 0;
    const account = (u: Usage | null) => {
      if (!u) return;
      usage.input += u.input_tokens;
      usage.output += u.output_tokens;
      usd += usdOfUsage(u);
    };
    const done = (events: NewFactEvent[], covered: TurnInput[], attempts: number, error: ExtractTurnResult["error"], noFacts: boolean): ExtractTurnResult => {
      const coveredIds = new Set(covered.map((t) => t.turnId));
      return {
        events, ms: now() - t0, usage, model: art.model, extractorVersion: art.version, cached: false,
        coveredTurnIds: [...coveredIds], failedTurnIds: newTurns.map((t) => t.turnId).filter((id) => !coveredIds.has(id)),
        attempts, usd, error, noFacts,
      };
    };
    if (!newTurns.length) return done([], [], 0, null, true);

    const first = await this.attempt(eng, input, input.recent, newTurns);
    account(first.ok ? first.usage : first.usage);
    if (first.ok) {
      return done(this.post(eng, first.patch, newTurns, input), newTurns, 1, null, first.patch.no_facts);
    }
    exLog.warn("extraction attempt failed", { caseId: input.caseId, code: first.code, message: first.message, ms: Math.round(first.ms), turns: newTurns.length });
    if (!first.retry) return done([], [], 1, { code: first.code, message: first.message }, false);

    if (first.code === "E_OPENAI_RATE") {
      const wait = Math.min(first.retryAfterMs ?? this.o.rateRetryDelayMs ?? 750, this.o.rateRetryDelayMs ?? 750);
      await (this.o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))))(wait);
    }
    const newest = newTurns.at(-1)!;
    const recent = [...input.recent, ...newTurns.slice(0, -1)].slice(-art.recentTurns);
    const second = await this.attempt(eng, input, recent, [newest]);
    account(second.ok ? second.usage : second.usage);
    if (second.ok) {
      return done(this.post(eng, second.patch, [newest], input), [newest], 2, { code: first.code, message: first.message }, second.patch.no_facts);
    }
    exLog.warn("extraction retry failed", { caseId: input.caseId, code: second.code, message: second.message, ms: Math.round(second.ms) });
    return done([], [], 2, { code: second.code, message: second.message }, false);
  }

  private post(eng: ExtractorEngine, patch: RawPatch, turns: TurnInput[], input: ExtractTurnInput): NewFactEvent[] {
    return eng.applyExtraction(patch, turns, { caseId: input.caseId, policy: input.policy, callDate: input.callDate });
  }

  private async attempt(eng: ExtractorEngine, input: ExtractTurnInput, recent: readonly TurnInput[], newTurns: readonly TurnInput[]): Promise<Attempt> {
    const art = eng.extractor;
    const userInput = eng.buildExtractorInput({ callDate: input.callDate, policy: input.policy, state: input.state, recent, newTurns });
    const t0 = performance.now();
    const ctl = new AbortController();
    const timeoutMs = this.timeoutMs;
    const timer = setTimeout(() => ctl.abort(), timeoutMs + 250);
    try {
      const r = await extractStructured<unknown>(this.client(), {
        model: art.model,
        instructions: art.prompt,
        input: userInput,
        format: { name: art.format.name, schema: art.format.schema, strict: art.format.strict ?? true },
        reasoningEffort: art.effort,
        temperature: 0,
        maxOutputTokens: this.o.maxOutputTokens ?? EXTRACT_MAX_OUTPUT_TOKENS,
        store: false,
        request: { timeoutMs, maxRetries: 0, signal: ctl.signal },
        ...(this.o.onTrace ? { onTrace: this.o.onTrace } : {}),
        label: "extract",
      });
      const s = sanitizePatch(r.data);
      if (!s) return { ok: false, code: "E_OPENAI_REFUSAL", message: "unparseable patch", retry: true, usage: r.usage, ms: performance.now() - t0 };
      return { ok: true, patch: s.patch, usage: r.usage, ms: r.ms, dropped: s.dropped };
    } catch (err) {
      return classify(err, performance.now() - t0);
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Map an OpenAI failure to the §7.4 error taxonomy and the §5.3 retry rule. */
export function classify(err: unknown, ms: number): Extract<Attempt, { ok: false }> {
  if (err instanceof BatonError) return { ok: false, code: err.code, message: err.message, retry: false, usage: null, ms };
  if (err instanceof RefusalError) return { ok: false, code: "E_OPENAI_REFUSAL", message: "model refused", retry: false, usage: null, ms };
  if (err instanceof IncompleteError) return { ok: false, code: "E_OPENAI_TIMEOUT", message: `incomplete: ${err.reason}`, retry: true, usage: null, ms };
  if (err instanceof APIConnectionTimeoutError || err instanceof APIUserAbortError || (err instanceof Error && err.name === "AbortError")) {
    return { ok: false, code: "E_OPENAI_TIMEOUT", message: "timeout", retry: true, usage: null, ms };
  }
  if (err instanceof RateLimitError) {
    const ra = Number(err.headers?.get?.("retry-after-ms") ?? NaN);
    return { ok: false, code: "E_OPENAI_RATE", message: "rate limited", retry: true, usage: null, ms, ...(Number.isFinite(ra) ? { retryAfterMs: ra } : {}) };
  }
  if (err instanceof SyntaxError) return { ok: false, code: "E_OPENAI_REFUSAL", message: "invalid JSON output", retry: true, usage: null, ms };
  if (err instanceof APIError) {
    const status = err.status ?? 0;
    return { ok: false, code: status === 429 ? "E_OPENAI_RATE" : "E_OPENAI_TIMEOUT", message: `upstream ${status || "connection"} error`, retry: status === 0 || status === 408 || status === 409 || status === 429 || status >= 500, usage: null, ms };
  }
  return { ok: false, code: "E_OPENAI_TIMEOUT", message: err instanceof Error ? err.name : "unknown error", retry: true, usage: null, ms };
}

export { zeroUsage };
