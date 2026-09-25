/**
 * qa/index.ts - `computeQa(input): QaResult` (DESIGN §5.13): the deterministic re-ask counter and the
 * disclosure-verbatim check over the agent channel of the AI half. WP8 runs it on the async multichannel transcript
 * (ch2 = agent) and, provisionally, on `transcript.agent` finals (no timings).
 *
 * WP14a·3: `computeQa(input, spec?)` (TASKS-v2 §2 rule 9): the spec's QA lexicon and spoken forms; with a compiled
 * relay's spec also `qa.verbatimThreshold` and `qa.reaskTargets` (PLATFORM §4.3). Without a spec: unchanged.
 */
import type { CaseState, DisclosureKind, FieldId, PolicyRecord } from "../contracts/case";
import type { QaResult } from "../contracts/events";
import type { ToolName } from "../contracts/tools";
import type { IntentSpec } from "../contracts/v2/relay";
import { specKernelOf } from "../relay/spec-link";
import { normTokens, splitSentences } from "./norm";
import { classifySentence } from "./reask";
import { verbatimCheck } from "./verbatim";

export * from "./norm";
export * from "./reask";
export * from "./verbatim";

export interface QaWord { text: string; startMs: number; endMs: number }
/** One agent (ch2) or customer (ch1) utterance. `startMs`/`words` are null/absent in the provisional variant. */
export interface QaUtterance { text: string; startMs: number | null; endMs?: number | null; words?: QaWord[] }

export interface QaDisclosure {
  kind: DisclosureKind;
  /** The exact text `get_disclosure` returned (takeovers.metrics.disclosures[kind]). */
  text: string;
  criticalTokens: string[];
  /** When the `get_disclosure` result was sent (same clock as the utterances); null → search everything. */
  atMs: number | null;
}

export interface QaInput {
  provisional: boolean;
  snapshot: Pick<CaseState, "fields">;
  policy: PolicyRecord;
  /** Agent utterances (async ch2, or `transcript.agent` finals with kind "speech"). */
  ch2: QaUtterance[];
  /** Customer utterances (ch1); not used by the metrics yet. */
  ch1?: QaUtterance[];
  toolCalls: { name: ToolName; atMs: number | null }[];
  disclosures: QaDisclosure[];
  /** The compiled greeting. Prepended to ch2 when `prependGreeting` (e.g. a provisional transcript without it). */
  greeting: string;
  prependGreeting?: boolean;
  payment: QaResult["payment"];
  handedBack: boolean;
  aiSeconds: number;
  latency?: { clickToFirstAudibleMs?: number | null; deadAirAfterRepMs?: number | null; turnLatencyP50Ms?: number | null };
}

/** Search window around a disclosure's tool result (§5.13 step 6.2): 2 s before to 60 s after. */
export const DISCLOSURE_WINDOW_BEFORE_MS = 2_000;
export const DISCLOSURE_WINDOW_AFTER_MS = 60_000;

interface Sent { sentence: string; atMs: number; tokens: string[] }

/** Split utterances into sentences with a start time (first word's start, else the utterance start, else 0). */
export function sentencesOf(utts: readonly QaUtterance[]): Sent[] {
  const out: Sent[] = [];
  for (const u of utts) {
    const words = u.words ?? [];
    const textToks = [...u.text.matchAll(/\S+/g)].map((m) => m.index);
    for (const { sentence, start } of splitSentences(u.text)) {
      let atMs = u.startMs ?? 0;
      if (words.length && textToks.length) {
        const ti = Math.max(0, textToks.findIndex((s) => s >= start));
        const wi = words.length === textToks.length ? ti : Math.min(words.length - 1, Math.floor((ti * words.length) / textToks.length));
        atMs = words[wi]!.startMs;
      }
      out.push({ sentence, atMs, tokens: normTokens(sentence) });
    }
  }
  return out;
}

/** `computeQa(input)` (§5.13 algorithm, steps 1–7). */
export function computeQa(input: QaInput, spec?: IntentSpec): QaResult {
  const kernel = specKernelOf(spec);
  const targets = kernel && kernel.reaskTargets.length ? new Set<string>(kernel.reaskTargets) : null;
  const utts = input.prependGreeting && input.greeting ? [{ text: input.greeting, startMs: 0 }, ...input.ch2] : input.ch2;
  const sents = sentencesOf(utts);

  // Step 6 first: the best window per disclosure; its sentences are excluded from the re-ask count (step 2).
  const excluded = new Set<number>();
  const disclosures: QaResult["disclosures"] = [];
  for (const d of input.disclosures) {
    const idx = sents
      .map((s, i) => ({ s, i }))
      .filter(({ s }) => d.atMs === null || (s.atMs >= d.atMs - DISCLOSURE_WINDOW_BEFORE_MS && s.atMs <= d.atMs + DISCLOSURE_WINDOW_AFTER_MS))
      .map(({ i }) => i);
    const stream: { tok: string; sent: number }[] = idx.flatMap((i) => sents[i]!.tokens.map((tok) => ({ tok, sent: i })));
    const r = verbatimCheck(d.text, stream.map((x) => x.tok), d.criticalTokens);
    const ok = kernel ? r.similarity >= kernel.verbatimThreshold && r.missingCritical.length === 0 : r.ok;
    disclosures.push({ kind: d.kind, similarity: Math.round(r.similarity * 1000) / 1000, ok, missingCritical: r.missingCritical });
    const inWin = new Map<number, number>();
    for (let k = r.window[0]; k < r.window[1]; k++) inWin.set(stream[k]!.sent, (inWin.get(stream[k]!.sent) ?? 0) + 1);
    for (const [i, n] of inWin) if (n * 2 >= sents[i]!.tokens.length) excluded.add(i);
  }

  const details: QaResult["details"] = [];
  const byClass = { reask: new Set<FieldId>(), new: new Set<FieldId>(), pending_confirm: new Set<FieldId>(), verified_reconfirm: new Set<FieldId>() };
  let adviceFlags = 0;
  sents.forEach((s, i) => {
    if (excluded.has(i)) return;
    const c0 = classifySentence(s.sentence, input.snapshot, input.policy, spec);
    const c = targets ? { ...c0, fields: c0.fields.filter((f) => targets.has(f.field)) } : c0;
    if (c.advice) { adviceFlags++; details.push({ sentence: s.sentence, atMs: s.atMs, field: null, classification: "advice" }); }
    if (!c.isRequest) return;
    if (!c.fields.length) { if (!c.advice) details.push({ sentence: s.sentence, atMs: s.atMs, field: null, classification: "other" }); return; }
    for (const f of c.fields) {
      byClass[f.classification].add(f.field);
      details.push({ sentence: s.sentence, atMs: s.atMs, field: f.field, classification: f.classification });
    }
  });

  return {
    provisional: input.provisional,
    reAsked: byClass.reask.size,
    newlyAsked: byClass.new.size,
    pendingConfirmed: byClass.pending_confirm.size,
    verifiedReconfirmed: byClass.verified_reconfirm.size,
    disclosures,
    clickToFirstAudibleMs: input.latency?.clickToFirstAudibleMs ?? null,
    deadAirAfterRepMs: input.latency?.deadAirAfterRepMs ?? null,
    turnLatencyP50Ms: input.latency?.turnLatencyP50Ms ?? null,
    payment: input.payment,
    handedBack: input.handedBack,
    aiSeconds: input.aiSeconds,
    adviceFlags,
    details,
  };
}
