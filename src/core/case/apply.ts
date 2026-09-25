/**
 * case/apply.ts - deterministic post-processing of one extractor patch (DESIGN §5.3 "Post-processing"):
 * drop foreign/empty events, set party from the turn's channel, normalize, align evidence to word timings, copy
 * late/cut. `seq` is assigned by the repository inside the F1 transaction (G0: extractor output has no seq).
 *
 * WP14a·3: `applyExtraction` and `verifierDisagreementEvents` take an optional trailing `spec?: IntentSpec` (TASKS-v2
 * §2 rule 9): normalize/compare through the spec, and events naming a field the spec does not have are dropped.
 */
import type { CaseState, Evidence, FactEvent, FieldId, NewFactEvent, PolicyRecord } from "../contracts/case";
import type { RawPatch, VerifierResult } from "../contracts/extract";
import type { TurnInput } from "../contracts/turns";
import type { IntentSpec } from "../contracts/v2/relay";
import { fieldOps } from "./field-ops";
import { lcsLength } from "./text";

export type EvidenceTurn = Pick<TurnInput, "channel" | "turnId" | "text" | "startMs" | "endMs" | "words" | "source">;

export interface ApplyCtx {
  caseId: string;
  policy: PolicyRecord;
  /** Defaults to `policy.callDate`. */
  callDate?: string;
  /** Event id factory; default `${caseId}:${turnId}:${index}` (deterministic, so a replayed patch collides). */
  newId?: (turnId: string, index: number) => string;
}

/** §5.3 step 5.2: minimum token-LCS ratio for the fuzzy quote match. */
export const QUOTE_LCS_MIN_RATIO = 0.8;
/** §5.3 step 5.3: the whole-turn fallback truncates the quote to this many chars. */
export const QUOTE_FALLBACK_MAX_CHARS = 200;

const evidenceSource = (s: TurnInput["source"]): Evidence["source"] => (s === "stt_cache" ? "stt_cache" : "stt_live");

/** Lower-case + whitespace-collapsed text with a map from each normalized char back to its original index. */
function normWithMap(s: string): { norm: string; map: number[] } {
  let norm = "";
  const map: number[] = [];
  let pendingSpace = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (/\s/.test(ch)) { pendingSpace = norm.length > 0; continue; }
    if (pendingSpace) { norm += " "; map.push(i - 1); pendingSpace = false; }
    norm += ch.toLowerCase();
    map.push(i);
  }
  return { norm, map };
}

interface Tok { t: string; start: number; end: number }
const tokensWithPos = (s: string): Tok[] => {
  const out: Tok[] = [];
  const re = /[\p{L}\p{N}]+(?:['’.][\p{L}\p{N}]+)*/gu;
  for (let m = re.exec(s); m; m = re.exec(s)) out.push({ t: m[0].toLowerCase().replace(/’/g, "'"), start: m.index, end: m.index + m[0].length });
  return out;
};

/** Char span [start, end) of `quote` in `text`: exact (case/whitespace-insensitive), else best token-LCS window ≥ 0.8. */
export function locateQuote(quote: string, text: string): { start: number; end: number; how: "exact" | "lcs" } | null {
  const q = normWithMap(quote).norm;
  if (q) {
    const { norm, map } = normWithMap(text);
    const at = norm.indexOf(q);
    if (at >= 0) return { start: map[at]!, end: map[at + q.length - 1]! + 1, how: "exact" };
  }
  const qt = tokensWithPos(quote).map((x) => x.t);
  const tt = tokensWithPos(text);
  if (!qt.length || !tt.length) return null;
  let best: { start: number; end: number; ratio: number; len: number } | null = null;
  const minLen = Math.max(1, Math.ceil(qt.length * QUOTE_LCS_MIN_RATIO));
  const maxLen = Math.min(tt.length, qt.length + 2);
  for (let s = 0; s < tt.length; s++) {
    for (let L = minLen; L <= maxLen && s + L <= tt.length; L++) {
      const win = tt.slice(s, s + L);
      const ratio = lcsLength(qt, win.map((x) => x.t)) / qt.length; // share of the quote's tokens found, in order
      if (ratio >= QUOTE_LCS_MIN_RATIO && (!best || ratio > best.ratio || (ratio === best.ratio && L < best.len))) {
        best = { start: win[0]!.start, end: win[L - 1]!.end, ratio, len: L };
      }
    }
  }
  return best ? { start: best.start, end: best.end, how: "lcs" } : null;
}

/** Map a char span of the turn text to word indices (exact when token counts agree, proportional otherwise). */
function wordSpan(text: string, start: number, end: number, nWords: number): { i: number; j: number } {
  const tokens = [...text.matchAll(/\S+/g)].map((m) => ({ s: m.index, e: m.index + m[0].length }));
  const T = tokens.length;
  let ti = tokens.findIndex((t) => t.e > start);
  let tj = -1;
  for (let k = 0; k < T; k++) if (tokens[k]!.s < end) tj = k;
  if (ti < 0) ti = T - 1;
  if (tj < ti) tj = ti;
  if (T === nWords) return { i: ti, j: tj };
  const i = Math.min(nWords - 1, Math.floor((ti * nWords) / T));
  const j = Math.min(nWords - 1, Math.max(i, Math.ceil(((tj + 1) * nWords) / T) - 1));
  return { i, j };
}

/** §5.3 step 5: evidence for a quote inside a turn, with word-level timings when the turn has words. */
export function alignEvidence(quote: string, turn: EvidenceTurn): Evidence {
  const span = locateQuote(quote, turn.text);
  const base = { channel: turn.channel, turnId: turn.turnId, source: evidenceSource(turn.source) } as const;
  if (!span) {
    return { ...base, startMs: turn.startMs, endMs: turn.endMs, quote: (quote.trim() || turn.text).slice(0, QUOTE_FALLBACK_MAX_CHARS) };
  }
  const q = turn.text.slice(span.start, span.end);
  if (!turn.words.length) return { ...base, startMs: turn.startMs, endMs: turn.endMs, quote: q };
  const { i, j } = wordSpan(turn.text, span.start, span.end, turn.words.length);
  return { ...base, startMs: turn.words[i]!.startMs, endMs: turn.words[j]!.endMs, quote: q };
}

/**
 * `applyExtraction(raw, turns, ctx)` (§5.3 post-processing). `turns` are the NEW turns of the call; events whose
 * `turn_id` is not one of them are dropped, as are value-less events other than ack/denied/question.
 */
export function applyExtraction(raw: RawPatch, turns: readonly TurnInput[], ctx: ApplyCtx, spec?: IntentSpec): NewFactEvent[] {
  const byId = new Map(turns.map((t) => [t.turnId, t]));
  const callDate = ctx.callDate ?? ctx.policy.callDate;
  const ops = fieldOps({ policy: ctx.policy, callDate }, spec);
  const known = spec ? new Set<string>(spec.fieldIds) : null;
  const out: NewFactEvent[] = [];
  raw.events.forEach((e, index) => {
    const turn = byId.get(e.turn_id);
    if (!turn) return; // step 1
    if (known && !known.has(e.field)) return; // a field this intent does not have (spec runs only)
    if (e.kind !== "question" && e.kind !== "ack" && e.kind !== "denied" && (e.value === null || !e.value.trim())) return; // step 2
    const value = e.kind === "question" ? null : e.value;
    const norm = value === null ? null : (ops.normalize(e.field, value)?.norm ?? null); // step 4
    const ev: Omit<FactEvent, "seq"> = {
      id: ctx.newId ? ctx.newId(turn.turnId, index) : `${ctx.caseId}:${turn.turnId}:${index}`,
      caseId: ctx.caseId,
      field: e.field,
      kind: e.kind,
      party: turn.channel, // step 3
      valueRaw: value,
      valueNorm: norm,
      acknowledgesTurnId: e.acknowledges_turn_id,
      confidence: e.confidence,
      turnId: turn.turnId,
      turnEndMs: turn.endMs,
      late: turn.late, // step 6
      cut: turn.cut,
      evidence: alignEvidence(e.quote, turn), // step 5
      extractor: "luna",
    };
    out.push(ev);
  });
  return out;
}

// ------------------------------------------------------------------------------------------ other event producers

const SUPPORT_CONFIDENCE = { stated_and_confirmed: "high", stated_once: "medium", conflicting: "low" } as const;

/**
 * F2 step 3 (G0 encoding): sol's disagreements as `kind:"verifier"` events: fields where sol reports a
 * non-absent value that is MISSING in `state` or not compatible with its current value. `party:"verifier"`,
 * `extractor:"sol"`, `turnId:null`, `turnEndMs = uptoRecvMs`, confidence from sol's support, evidence = the first
 * cited turn (when it is in `turns`).
 */
export function verifierDisagreementEvents(
  result: VerifierResult,
  state: Pick<CaseState, "fields">,
  turns: readonly TurnInput[],
  ctx: ApplyCtx,
  spec?: IntentSpec,
): NewFactEvent[] {
  const callDate = ctx.callDate ?? ctx.policy.callDate;
  const ops = fieldOps({ policy: ctx.policy, callDate }, spec);
  const known = spec ? new Set<string>(spec.fieldIds) : null;
  const byId = new Map(turns.map((t) => [t.turnId, t]));
  const out: NewFactEvent[] = [];
  result.fields.forEach((f, index) => {
    if (f.support === "absent" || f.value === null) return;
    if (known && !known.has(f.field)) return;
    const norm = ops.normalize(f.field, f.value)?.norm ?? null;
    if (norm === null) return;
    const cur = state.fields[f.field];
    if (cur && cur.value !== null && ops.compatible(f.field, cur.value, norm)) return;
    const cited = f.turnIds.map((id) => byId.get(id)).find((t): t is TurnInput => !!t);
    out.push({
      id: ctx.newId ? ctx.newId(`verifier@${result.uptoRecvMs}`, index) : `${ctx.caseId}:verifier@${result.uptoRecvMs}:${f.field}`,
      caseId: ctx.caseId,
      field: f.field,
      kind: "verifier",
      party: "verifier",
      valueRaw: f.value,
      valueNorm: norm,
      acknowledgesTurnId: null,
      confidence: SUPPORT_CONFIDENCE[f.support],
      turnId: null,
      turnEndMs: result.uptoRecvMs,
      late: false,
      cut: false,
      evidence: cited ? alignEvidence(f.quote, cited) : null,
      extractor: "sol",
    });
  });
  return out;
}

/**
 * An accepted AI-half tool update (`update_case_field` / `confirm_effective_date`, §5.8) as a fact event:
 * `kind:"tool_update"`, `party:"ai"`, `extractor:"tool"`, confidence high. `turnEndMs` is on the CALL clock
 * (G0: `cases.t_arm_ms + (now − takeovers.armed_at)`, computed by the tool route); `evidence` may carry the VA clock.
 */
export function toolUpdateEvent(i: {
  id: string; caseId: string; field: FieldId; valueRaw: string; valueNorm: string; turnEndMs: number;
  evidence?: Evidence | null;
}): NewFactEvent {
  return {
    id: i.id, caseId: i.caseId, field: i.field, kind: "tool_update", party: "ai", valueRaw: i.valueRaw, valueNorm: i.valueNorm,
    acknowledgesTurnId: null, confidence: "high", turnId: null, turnEndMs: i.turnEndMs, late: false, cut: false,
    evidence: i.evidence ?? null, extractor: "tool",
  };
}
