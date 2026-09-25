/**
 * scenario/labels.ts - ground-truth labels (DESIGN §6.1), the pure half of `label-ground-truth.ts` and
 * `review-labels.ts`:
 *
 * 1. `utterancesFromTranscript`: an async MULTICHANNEL transcript of the take (ch1 = rep, ch2 = customer, rebuilt
 *    locally from the split WAVs) → numbered utterances on the call clock.
 * 2. The locator (sol, effort low) gets `buildLocatorInput(…)` + `LOCATOR_PROMPT` and answers in `LOCATOR_FORMAT`:
 *    per truth fact its FIRST mention and the other party's acknowledgement (utterance ids + verbatim quotes), the
 *    rep's hand-off line and the customer's reply, and where diagnosis ends / the admin tail starts.
 * 3. `resolveLabels`: quotes → word times, `CallLabels` (reviewed:false) + review flags (`LabelsAutoFile.items`).
 * 4. `applyLabelEdit`: the reviewer's edits (review-labels.ts).
 *
 * Field ids come from the take's scenario (its truth keys) and its intent spec, never from a list in this file.
 */
import type { Channel, FieldId } from "../contracts/case";
import type { LabelFlag, LabelsAutoFile } from "../contracts/ext/wp9-data";
import type { CallLabels, Scenario } from "../contracts/scenario";
import type { IntentSpec } from "./intent-spec";

export interface LabelWord {
  text: string;
  startMs: number;
  endMs: number;
}

export interface LabelUtterance {
  id: number;
  channel: Channel;
  startMs: number;
  endMs: number;
  text: string;
  words: LabelWord[];
}

/** The subset of an AssemblyAI async transcript this module reads. */
export interface TranscriptLike {
  utterances?: { speaker?: string | null; channel?: string | null; start: number; end: number; text: string; words?: { text: string; start: number; end: number; channel?: string | null }[] }[] | null;
}

/** Multichannel utterances → call-clock utterances sorted by start (ties: rep first), numbered from 1. */
export function utterancesFromTranscript(t: TranscriptLike, channelMap: Readonly<Record<string, Channel>> = { "1": "rep", "2": "customer" }): LabelUtterance[] {
  const out: Omit<LabelUtterance, "id">[] = [];
  for (const u of t.utterances ?? []) {
    const key = String(u.channel ?? u.speaker ?? "");
    const channel = channelMap[key];
    if (!channel) continue;
    const text = u.text.trim();
    if (!text) continue;
    out.push({ channel, startMs: u.start, endMs: u.end, text, words: (u.words ?? []).map((w) => ({ text: w.text, startMs: w.start, endMs: w.end })) });
  }
  out.sort((a, b) => a.startMs - b.startMs || (a.channel === b.channel ? 0 : a.channel === "rep" ? -1 : 1));
  return out.map((u, i) => ({ id: i + 1, ...u }));
}

export const fmtMs = (ms: number | null | undefined): string => {
  if (ms === null || ms === undefined) return "--:--.-";
  const s = ms / 1000;
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, "0")}:${(s - m * 60).toFixed(1).padStart(4, "0")}`;
};

// ------------------------------------------------------------------------------------------------ locator (sol)

export const LOCATOR_PROMPT = `You label ground truth for a recorded phone call between an insurance agency REP and a policyholder CUSTOMER.
You get the case's TRUE facts (field id, meaning, true value, who is expected to state it) and the call transcript as
numbered utterances "[id] ROLE mm:ss text" (the transcript may misspell names and numbers).
For EVERY listed fact:
- found: true only if the call actually states this fact (either party, any wording, a spelled-out or corrected value).
- utterance_id / quote: the FIRST utterance where the fact's value is stated, and a short VERBATIM quote (3-12 words,
  copied exactly from that utterance's text) containing the value.
- heard_value: the value as actually said there, in the true value's format; null if unclear.
- ack_utterance_id / ack_quote: the first LATER utterance by the OTHER party that confirms, repeats or reads back that
  value ("yes", "that's right", a read-back); null / "" if nobody acknowledges it.
- confidence: "low" if you are unsure about any of the above.
Hand-off: the REP's line offering to let an assistant finish (compare with the expected line; wording may differ) and
the CUSTOMER's reply right after it. Null ids if absent.
diagnosis_ends_utterance_id: the last utterance where a NEW fact or decision of the case is established.
tail_starts_utterance_id: the first utterance of the administrative tail (read-backs, the new premium quote, effective
date confirmation, disclosures, payment, confirmation, goodbye); null if the call has no tail.
Use only utterance ids that exist. Never invent quotes.`;

const nullable = (t: string) => ({ type: [t, "null"] });

export const LOCATOR_FORMAT = {
  name: "ground_truth_labels",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["facts", "handoff", "diagnosis_ends_utterance_id", "tail_starts_utterance_id"],
    properties: {
      facts: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["field", "found", "utterance_id", "quote", "heard_value", "ack_utterance_id", "ack_quote", "confidence"],
          properties: {
            field: { type: "string" },
            found: { type: "boolean" },
            utterance_id: nullable("integer"),
            quote: { type: "string" },
            heard_value: nullable("string"),
            ack_utterance_id: nullable("integer"),
            ack_quote: { type: "string" },
            confidence: { type: "string", enum: ["high", "low"] },
          },
        },
      },
      handoff: {
        type: "object",
        additionalProperties: false,
        required: ["line_utterance_id", "line_quote", "accept_utterance_id", "accept_quote", "confidence"],
        properties: {
          line_utterance_id: nullable("integer"),
          line_quote: { type: "string" },
          accept_utterance_id: nullable("integer"),
          accept_quote: { type: "string" },
          confidence: { type: "string", enum: ["high", "low"] },
        },
      },
      diagnosis_ends_utterance_id: nullable("integer"),
      tail_starts_utterance_id: nullable("integer"),
    },
  },
} as const;

export interface LocatedFact {
  field: string;
  found: boolean;
  utterance_id: number | null;
  quote: string;
  heard_value: string | null;
  ack_utterance_id: number | null;
  ack_quote: string;
  confidence: "high" | "low";
}

export interface LocatorOutput {
  facts: LocatedFact[];
  handoff: { line_utterance_id: number | null; line_quote: string; accept_utterance_id: number | null; accept_quote: string; confidence: "high" | "low" };
  diagnosis_ends_utterance_id: number | null;
  tail_starts_utterance_id: number | null;
}

export interface LocatorFact {
  field: FieldId;
  label: string;
  value: string;
  statedBy: Channel | null;
}

/** The facts the locator is asked about: every truth value of the take's scenario (its overrides applied). */
export function locatorFacts(scenario: Scenario, spec: IntentSpec, statedBy: Readonly<Partial<Record<string, Channel>>>): LocatorFact[] {
  return spec.fieldIds.flatMap((f) => {
    const value = scenario.truth[f];
    return value === undefined ? [] : [{ field: f, label: spec.label(f), value, statedBy: statedBy[f] ?? null }];
  });
}

export function buildLocatorInput(i: { facts: readonly LocatorFact[]; handoffLine: string; utterances: readonly LabelUtterance[] }): string {
  const facts = i.facts.map((f) => `- ${f.field} (${f.label}): "${f.value}"${f.statedBy ? `, expected from ${f.statedBy.toUpperCase()}` : ""}`).join("\n");
  const lines = i.utterances.map((u) => `[${u.id}] ${u.channel.toUpperCase()} ${fmtMs(u.startMs)} ${u.text}`).join("\n");
  return `TRUE FACTS:\n${facts}\n\nEXPECTED HAND-OFF LINE (rep): "${i.handoffLine}"\n\nTRANSCRIPT:\n${lines}`;
}

// ------------------------------------------------------------------------------------------------ quote → times

const tokens = (s: string): string[] =>
  s
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[’‘]/g, "'")
    .split(/[^\p{L}\p{N}']+/u)
    .map((t) => t.replace(/^'+|'+$/g, ""))
    .filter(Boolean);

export interface QuoteMatch {
  startMs: number;
  endMs: number;
  /** "exact" = every quote token in order; "fuzzy" = best window ≥ 60% tokens; "utterance" = whole utterance. */
  quality: "exact" | "fuzzy" | "utterance";
}

/** Locate a verbatim quote inside an utterance's words (word times), degrading to the whole utterance. */
export function matchQuote(u: LabelUtterance, quote: string): QuoteMatch {
  const q = tokens(quote);
  const w = u.words.map((x) => ({ ...x, tok: tokens(x.text).join("") }));
  const whole: QuoteMatch = { startMs: u.startMs, endMs: u.endMs, quality: "utterance" };
  if (!q.length || !w.length) return whole;
  const qj = q.map((t) => t.replace(/'/g, ""));
  // Exact: a run of words whose concatenated tokens equal the quote tokens (a word may hold "44107" or "it's").
  const flat = qj.join("");
  for (let s = 0; s < w.length; s++) {
    let acc = "";
    for (let e = s; e < w.length; e++) {
      acc += w[e]!.tok.replace(/'/g, "");
      if (acc === flat) return { startMs: w[s]!.startMs, endMs: w[e]!.endMs, quality: "exact" };
      if (!flat.startsWith(acc)) break;
    }
  }
  // Fuzzy: best window of the quote's length by token hits.
  const n = Math.min(q.length, w.length);
  let best = { hits: 0, score: 0, s: 0 };
  for (let s = 0; s + n <= w.length; s++) {
    let hits = 0;
    for (let k = 0; k < n; k++) if (qj.includes(w[s + k]!.tok.replace(/'/g, ""))) hits++;
    // Ties: prefer the window that starts on the quote's first word.
    const score = hits + (w[s]!.tok.replace(/'/g, "") === qj[0] ? 0.5 : 0);
    if (score > best.score) best = { hits, score, s };
  }
  if (best.hits / q.length >= 0.6) return { startMs: w[best.s]!.startMs, endMs: w[best.s + n - 1]!.endMs, quality: "fuzzy" };
  return whole;
}

// ------------------------------------------------------------------------------------------------ resolve

export interface ResolveInput {
  callId: string;
  scenario: Scenario;
  spec: IntentSpec;
  /** Kit `stated_by` per field (channel_mismatch flag). */
  statedBy: Readonly<Partial<Record<string, Channel>>>;
  /** Fields the take's sidecar overrides (value or status). */
  overridden: ReadonlySet<string>;
  utterances: readonly LabelUtterance[];
  located: LocatorOutput;
}

export interface ResolvedLabels {
  labels: CallLabels;
  items: LabelsAutoFile["items"];
}

export function resolveLabels(i: ResolveInput): ResolvedLabels {
  const byId = new Map(i.utterances.map((u) => [u.id, u]));
  const items: LabelsAutoFile["items"] = [];
  const mentions: CallLabels["mentions"] = [];
  const locatedBy = new Map(i.located.facts.map((f) => [f.field, f]));

  for (const f of i.spec.fieldIds) {
    const truth = i.scenario.truth[f];
    if (truth === undefined) continue;
    const flags: LabelFlag[] = [];
    const notes: string[] = [];
    if (i.overridden.has(f)) flags.push("override");
    const loc = locatedBy.get(f);
    const u = loc?.found && loc.utterance_id !== null ? byId.get(loc.utterance_id) : undefined;
    const expected = i.scenario.expectedAtHandoff[f];
    if (!loc || !loc.found || !u) {
      if (expected === "VERIFIED" || expected === "PENDING") flags.push("not_found");
      if (loc?.found && !u) notes.push(`utterance ${loc.utterance_id} does not exist`);
      items.push({ key: f, field: f, channel: null, flags, note: notes.join("; ") || "not stated in the call" });
      continue;
    }
    const m = matchQuote(u, loc.quote);
    if (loc.confidence === "low" || m.quality === "utterance") flags.push("low_confidence");
    if (m.quality !== "exact") notes.push(`quote match: ${m.quality}`);
    if (loc.heard_value !== null) {
      const heard = i.spec.normalize(f, loc.heard_value, { policy: i.scenario.policy, callDate: i.scenario.callDate });
      if (heard === null) {
        if (!flags.includes("low_confidence")) flags.push("low_confidence");
        notes.push(`heard "${loc.heard_value}" did not normalize`);
      } else if (heard !== truth) {
        flags.push("value_mismatch");
        notes.push(`heard ${heard}, truth ${truth}`);
      }
    }
    const expectedFrom = i.statedBy[f];
    if (expectedFrom && expectedFrom !== u.channel) flags.push("channel_mismatch");
    let ackedAtMs: number | null = null;
    const ack = loc.ack_utterance_id !== null ? byId.get(loc.ack_utterance_id) : undefined;
    if (ack) {
      if (ack.channel === u.channel) notes.push(`ack utterance ${ack.id} is by the same party; ignored`);
      else if (ack.startMs < m.startMs) notes.push(`ack utterance ${ack.id} precedes the mention; ignored`);
      else ackedAtMs = matchQuote(ack, loc.ack_quote).startMs;
    }
    mentions.push({ field: f, valueNorm: truth, channel: u.channel, statedAtMs: m.startMs, ackedAtMs, quote: loc.quote });
    items.push({ key: f, field: f, channel: u.channel, flags, note: notes.join("; ") });
  }

  // Hand-off line (rep) + the customer's reply.
  const h = i.located.handoff;
  const line = h.line_utterance_id !== null ? byId.get(h.line_utterance_id) : undefined;
  let handoff: CallLabels["handoff"] = null;
  const hFlags: LabelFlag[] = [];
  const hNotes: string[] = [];
  if (line && line.channel === "rep") {
    const lm = matchQuote(line, h.line_quote);
    const acc = h.accept_utterance_id !== null ? byId.get(h.accept_utterance_id) : undefined;
    let accept: QuoteMatch | null = null;
    if (acc && acc.channel === "customer" && acc.startMs >= lm.startMs) accept = matchQuote(acc, h.accept_quote);
    else if (acc) hNotes.push(`reply utterance ${acc.id} is not a later customer utterance; ignored`);
    if (!accept) hFlags.push("handoff_missing");
    if (h.confidence === "low" || lm.quality === "utterance") hFlags.push("low_confidence");
    handoff = { lineStartMs: lm.startMs, lineEndMs: lm.endMs, acceptStartMs: accept?.startMs ?? null, acceptEndMs: accept?.endMs ?? null };
    if (!accept) hNotes.push("no customer reply located (acceptStartMs null → synthetic 'Sure.')");
  } else {
    hFlags.push("handoff_missing");
    hNotes.push(line ? `utterance ${line.id} is not a rep utterance` : "no hand-off line located");
  }
  items.push({ key: "handoff", field: null, channel: "rep", flags: hFlags, note: hNotes.join("; ") });

  const at = (id: number | null, edge: "start" | "end"): number | null => {
    const u = id !== null ? byId.get(id) : undefined;
    return u ? (edge === "start" ? u.startMs : u.endMs) : null;
  };
  mentions.sort((a, b) => a.statedAtMs - b.statedAtMs);
  return {
    labels: {
      callId: i.callId,
      reviewed: false,
      mentions,
      handoff,
      diagnosisEndsMs: at(i.located.diagnosis_ends_utterance_id, "end"),
      tailStartsMs: at(i.located.tail_starts_utterance_id, "start"),
    },
    items,
  };
}

// ------------------------------------------------------------------------------------------------ review edits

export type LabelEdit =
  | { op: "set"; field: string; key: "statedAtMs" | "ackedAtMs"; ms: number | null }
  | { op: "drop"; field: string }
  | { op: "handoff"; key: "lineStartMs" | "lineEndMs" | "acceptStartMs" | "acceptEndMs"; ms: number | null }
  | { op: "no_handoff" }
  | { op: "call"; key: "diagnosisEndsMs" | "tailStartsMs"; ms: number | null }
  | { op: "reviewed"; value: boolean };

/** Parse a CLI edit: `maya.statedAtMs=12.5s`, `driver_dob.ackedAtMs=null`, `drop:driver_age`, `handoff.acceptStartMs=95300`,
 *  `handoff=none`, `tailStartsMs=01:31.2`. Times: ms, `12.5s`, or `mm:ss(.s)`. */
export function parseLabelEdit(s: string): LabelEdit {
  const time = (v: string): number | null => {
    const t = v.trim();
    if (t === "null" || t === "none") return null;
    const mmss = /^(\d+):(\d{1,2}(?:\.\d+)?)$/.exec(t);
    if (mmss) return Math.round((Number(mmss[1]) * 60 + Number(mmss[2])) * 1000);
    const sec = /^(\d+(?:\.\d+)?)s$/.exec(t);
    if (sec) return Math.round(Number(sec[1]) * 1000);
    if (/^\d+(?:\.\d+)?$/.test(t)) return Math.round(Number(t));
    throw new Error(`not a time: ${v} (use ms, 12.5s or mm:ss.s)`);
  };
  if (s.startsWith("drop:")) return { op: "drop", field: s.slice(5) };
  if (s === "handoff=none") return { op: "no_handoff" };
  const m = /^([\w-]+)(?:\.(\w+))?=(.+)$/.exec(s);
  if (!m) throw new Error(`cannot parse edit "${s}"`);
  const [, a, b, v] = m as unknown as [string, string, string | undefined, string];
  if (a === "handoff" && (b === "lineStartMs" || b === "lineEndMs" || b === "acceptStartMs" || b === "acceptEndMs")) return { op: "handoff", key: b, ms: time(v) };
  if (!b && (a === "diagnosisEndsMs" || a === "tailStartsMs")) return { op: "call", key: a, ms: time(v) };
  if (!b && a === "reviewed") return { op: "reviewed", value: v === "true" };
  if (b === "statedAtMs" || b === "ackedAtMs") return { op: "set", field: a, key: b, ms: time(v) };
  throw new Error(`cannot parse edit "${s}"`);
}

export function applyLabelEdit(l: CallLabels, e: LabelEdit): CallLabels {
  const next: CallLabels = structuredClone(l);
  switch (e.op) {
    case "set": {
      const m = next.mentions.find((x) => x.field === e.field);
      if (!m) throw new Error(`no mention of ${e.field}`);
      if (e.key === "statedAtMs") {
        if (e.ms === null) throw new Error("statedAtMs cannot be null (drop the mention instead)");
        m.statedAtMs = e.ms;
      } else m.ackedAtMs = e.ms;
      next.mentions.sort((a, b) => a.statedAtMs - b.statedAtMs);
      break;
    }
    case "drop":
      if (!next.mentions.some((x) => x.field === e.field)) throw new Error(`no mention of ${e.field}`);
      next.mentions = next.mentions.filter((x) => x.field !== e.field);
      break;
    case "handoff": {
      if (!next.handoff) {
        if (e.key !== "lineStartMs" || e.ms === null) throw new Error("no hand-off labelled: set handoff.lineStartMs first");
        next.handoff = { lineStartMs: e.ms, lineEndMs: e.ms, acceptStartMs: null, acceptEndMs: null };
      } else if ((e.key === "lineStartMs" || e.key === "lineEndMs") && e.ms === null) throw new Error(`${e.key} cannot be null (use handoff=none)`);
      else (next.handoff as Record<string, number | null>)[e.key] = e.ms;
      break;
    }
    case "no_handoff":
      next.handoff = null;
      break;
    case "call":
      next[e.key] = e.ms;
      break;
    case "reviewed":
      next.reviewed = e.value;
      break;
  }
  return next;
}

/** Sanity problems that block `reviewed:true` (the review CLI refuses to approve with these). */
export function labelProblems(l: CallLabels, durationMs: number | null): string[] {
  const p: string[] = [];
  const inRange = (ms: number | null) => ms === null || (ms >= 0 && (durationMs === null || ms <= durationMs + 2000));
  for (const m of l.mentions) {
    if (!inRange(m.statedAtMs)) p.push(`${m.field}: statedAtMs ${m.statedAtMs} out of range`);
    if (m.ackedAtMs !== null && m.ackedAtMs < m.statedAtMs) p.push(`${m.field}: acked before stated`);
  }
  const seen = new Set<string>();
  for (const m of l.mentions) {
    if (seen.has(m.field)) p.push(`${m.field}: more than one mention`);
    seen.add(m.field);
  }
  const h = l.handoff;
  if (h) {
    if (h.lineEndMs < h.lineStartMs) p.push("handoff: line ends before it starts");
    if (h.acceptStartMs !== null && h.acceptStartMs < h.lineStartMs) p.push("handoff: acceptance before the line");
    if ((h.acceptStartMs === null) !== (h.acceptEndMs === null)) p.push("handoff: acceptStartMs/acceptEndMs must both be set or both null");
    if (h.acceptEndMs !== null && h.acceptStartMs !== null && h.acceptEndMs < h.acceptStartMs) p.push("handoff: acceptance ends before it starts");
  }
  if (l.diagnosisEndsMs !== null && l.tailStartsMs !== null && l.tailStartsMs < l.diagnosisEndsMs - 60_000) p.push("tail starts long before diagnosis ends");
  return p;
}
