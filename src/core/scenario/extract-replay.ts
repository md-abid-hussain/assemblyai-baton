/**
 * scenario/extract-replay.ts - the extraction cache (DESIGN §6.3) and the verifier cache, as pure loops over
 * injected ports (TASKS §2 `Extractor` / `Verifier`; the script binds WP3's luna/sol and WP1's engine).
 *
 * Extraction: cached finals in recvMs order go through the production extractor SEQUENTIALLY, single-turn calls
 * (WP3 measured 3-turn batches as less accurate), each seeing the case state derived from the events so far, so each
 * patch sees the same prior state as live. Per turn it records the events (without id/caseId, WP3 re-ids them as
 * `${caseId}:${turnId}:${index}`, so the order is kept) and the measured `extractMs`.
 *
 * Verifier: sol at a 30 s call-time cadence over the finals received by then. A run is usable at `t` when
 * `startMs + ms ≤ t`; runs never overlap (the next one starts at max(next tick, previous start + ms)).
 */
import type { CaseState, NewFactEvent, PolicyRecord } from "../contracts/case";
import type { CachedFactEvent, ExtractCacheFile, PipelineVersion, SttVariant, VerifierCacheFile } from "../contracts/eval";
import type { Extractor, Verifier } from "../contracts/services";
import type { TurnInput } from "../contracts/turns";

/** An event as WP1's `deriveCaseState` takes it (seq assigned in arrival order). */
export type ReplayEvent = NewFactEvent & { seq: number };
export type DeriveFn = (policy: PolicyRecord, events: readonly ReplayEvent[], ctx: { caseId: string }) => CaseState;

export const RECENT_TURNS = 6;

export interface ExtractReplayInput {
  callId: string;
  version: PipelineVersion;
  variant: SttVariant;
  caseId: string;
  policy: PolicyRecord;
  callDate: string;
  turns: readonly TurnInput[];
  /** ISO timestamp written into the file (injected so tests are deterministic). */
  createdAt: string;
}

export interface ExtractReplayDeps {
  extractor: Extractor;
  derive: DeriveFn;
  /** Extra attempts for a turn the extractor reported as failed (WP3 `failedTurnIds`). Default 1. */
  retries?: number;
  onTurn?: (i: { index: number; total: number; turnId: string; events: number; ms: number; failed: boolean }) => void;
}

export interface ExtractReplayResult {
  file: ExtractCacheFile;
  failedTurnIds: string[];
  usage: { input: number; output: number };
  /** Sum of WP3's `usd` when the extractor reports it. */
  usd: number;
}

const toCached = (e: NewFactEvent): CachedFactEvent => {
  const { id: _id, caseId: _caseId, ...rest } = e;
  return rest;
};

const failedIn = (out: unknown, turnId: string): boolean => {
  const f = (out as { failedTurnIds?: unknown }).failedTurnIds;
  return Array.isArray(f) && f.includes(turnId);
};

export async function replayExtraction(i: ExtractReplayInput, deps: ExtractReplayDeps): Promise<ExtractReplayResult> {
  const turns = [...i.turns];
  const events: ReplayEvent[] = [];
  const out: ExtractCacheFile["turns"] = [];
  const failed: string[] = [];
  const usage = { input: 0, output: 0 };
  let usd = 0;
  let model = "";
  let extractorVersion = "";
  for (let k = 0; k < turns.length; k++) {
    const turn = turns[k]!;
    const state = deps.derive(i.policy, events, { caseId: i.caseId });
    const recent = turns.slice(Math.max(0, k - RECENT_TURNS), k);
    let attempt = 0;
    let res = await deps.extractor.extractTurn({ caseId: i.caseId, policy: i.policy, callDate: i.callDate, state, recent, newTurns: [turn] });
    const account = (r: typeof res) => {
      usage.input += r.usage.input;
      usage.output += r.usage.output;
      const u = (r as { usd?: unknown }).usd;
      if (typeof u === "number") usd += u;
    };
    account(res);
    while (failedIn(res, turn.turnId) && attempt < (deps.retries ?? 1)) {
      attempt++;
      res = await deps.extractor.extractTurn({ caseId: i.caseId, policy: i.policy, callDate: i.callDate, state, recent, newTurns: [turn] });
      account(res);
    }
    model ||= res.model;
    extractorVersion ||= res.extractorVersion;
    if (res.extractorVersion !== extractorVersion) throw new Error(`${i.callId}: extractorVersion changed mid-run (${extractorVersion} → ${res.extractorVersion})`);
    const isFailed = failedIn(res, turn.turnId);
    if (isFailed) failed.push(turn.turnId);
    const mine = res.events.filter((e) => e.turnId === turn.turnId || e.turnId === null);
    for (const e of mine) events.push({ ...e, seq: events.length + 1 });
    out.push({ turnId: turn.turnId, channel: turn.channel, recvMs: turn.recvMs, endMs: turn.endMs, extractMs: Math.max(0, res.ms), events: mine.map(toCached) });
    deps.onTurn?.({ index: k, total: turns.length, turnId: turn.turnId, events: mine.length, ms: res.ms, failed: isFailed });
  }
  return {
    file: { callId: i.callId, version: i.version, variant: i.variant, extractorVersion, model, createdAt: i.createdAt, turns: out },
    failedTurnIds: failed,
    usage,
    usd,
  };
}

// ------------------------------------------------------------------------------------------------ verifier cache

export const VERIFY_CADENCE_MS = 30_000;

export interface VerifyReplayInput {
  callId: string;
  variant: SttVariant;
  caseId: string;
  policy: PolicyRecord;
  callDate: string;
  turns: readonly TurnInput[];
  /** Last call ms to schedule a run at (the call's duration). */
  endMs: number;
  cadenceMs?: number;
  createdAt: string;
  model: string;
}

/** The next run's start: the first cadence tick after the previous run has finished (runs never overlap). */
export function nextVerifyStart(prevStartMs: number, prevMs: number, cadenceMs = VERIFY_CADENCE_MS): number {
  return Math.ceil(Math.max(prevStartMs + cadenceMs, prevStartMs + prevMs) / cadenceMs) * cadenceMs;
}

export async function replayVerifier(
  i: VerifyReplayInput,
  deps: { verifier: Verifier; onRun?: (r: { startMs: number; ms: number; turns: number }) => void },
): Promise<{ file: VerifierCacheFile; usd: number }> {
  const cadence = i.cadenceMs ?? VERIFY_CADENCE_MS;
  const turns = [...i.turns].sort((a, b) => a.recvMs - b.recvMs);
  const runs: VerifierCacheFile["runs"] = [];
  let usd = 0;
  let lastCount = 0;
  for (let t = cadence; t <= i.endMs; ) {
    const upto = turns.filter((x) => x.recvMs <= t);
    if (upto.length === 0 || upto.length === lastCount) {
      t += cadence; // nothing new since the last run: sol would say the same thing
      continue;
    }
    const r = await deps.verifier.verifyCase({ caseId: i.caseId, policy: i.policy, callDate: i.callDate, turns: upto });
    usd += r.usd;
    runs.push({ startMs: t, ms: r.ms, result: { uptoRecvMs: r.uptoRecvMs, fields: r.fields } });
    deps.onRun?.({ startMs: t, ms: r.ms, turns: upto.length });
    lastCount = upto.length;
    t = nextVerifyStart(t, r.ms, cadence);
  }
  return { file: { callId: i.callId, variant: i.variant, model: i.model, createdAt: i.createdAt, runs }, usd };
}
