/**
 * compare.ts - score an async transcript against fixtures/dialog_script.json (pure functions, no network).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { FIXTURES_DIR } from "../lib/env.ts";
import type { Entity, Transcript, Utterance, Word } from "./client.ts";

export interface ScriptTurn {
  index: number;
  speaker: "adjuster" | "claimant";
  name: string;
  channel: "left" | "right";
  text: string;
  start_ms: number;
  end_ms: number;
}
export interface DialogScript {
  duration_ms: number;
  turns: ScriptTurn[];
  facts: Record<string, unknown>;
}

export function loadDialogScript(): DialogScript {
  return JSON.parse(readFileSync(resolve(FIXTURES_DIR, "dialog_script.json"), "utf8")) as DialogScript;
}

/** lowercase, keep [a-z0-9] only */
export const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Ground-truth facts and the normalized spellings that count as "captured". */
export const FACT_CHECKS: Array<{ key: string; label: string; variants: string[] }> = [
  { key: "insurer", label: "Harbor Point", variants: ["harborpoint", "harbourpoint"] },
  { key: "adjuster", label: "Daniel Reyes", variants: ["danielreyes"] },
  { key: "claimant", label: "Priya Shah", variants: ["priyashah"] },
  { key: "other_driver", label: "Mark Donnelly", variants: ["markdonnelly"] },
  { key: "body_shop", label: "Lakeside Auto Body", variants: ["lakesideautobody"] },
  { key: "policy_number", label: "HP7740391", variants: ["hp7740391"] },
  { key: "claim_number", label: "CL44812", variants: ["cl44812"] },
  { key: "phone", label: "415-555-0137", variants: ["4155550137"] },
  { key: "accident_address", label: "1420 Maple Avenue", variants: ["1420mapleavenue", "1420mapleave"] },
  { key: "mailing_address", label: "88 Birchwood Lane", variants: ["88birchwoodlane", "88birchwoodln"] },
  { key: "city", label: "Springfield", variants: ["springfield"] },
  { key: "date", label: "September 15th", variants: ["september15", "sept15", "915"] },
  { key: "day", label: "Tuesday", variants: ["tuesday"] },
  { key: "time_first", label: "5 p.m.", variants: ["5pm", "500pm", "fivepm"] },
  { key: "time_second", label: "7 p.m.", variants: ["7pm", "700pm", "sevenpm"] },
  { key: "callback", label: "Friday at 10 a.m.", variants: ["fridayat10am", "friday10am", "fridayat1000am"] },
  { key: "repair", label: "$3,450", variants: ["3450"] },
  { key: "tow", label: "$125", variants: ["125"] },
  { key: "deductible", label: "$500", variants: ["500"] },
];

export function factsFound(text: string | null | undefined): Record<string, boolean> {
  const n = norm(text ?? "");
  const out: Record<string, boolean> = {};
  for (const f of FACT_CHECKS) out[f.key] = f.variants.some((v) => n.includes(v));
  return out;
}

function turnAt(script: DialogScript, ms: number): ScriptTurn | undefined {
  let best: ScriptTurn | undefined;
  let bestDist = Infinity;
  for (const t of script.turns) {
    if (ms >= t.start_ms && ms <= t.end_ms) return t;
    const d = ms < t.start_ms ? t.start_ms - ms : ms - t.end_ms;
    if (d < bestDist) {
      bestDist = d;
      best = t;
    }
  }
  return bestDist <= 400 ? best : undefined;
}

/**
 * Word-level speaker accuracy: map each hypothesis label to the ground-truth speaker it overlaps most,
 * then count words whose midpoint falls in a turn of that speaker.
 */
export function speakerAccuracy(words: Word[] | null | undefined, script: DialogScript, labelToTruth?: (label: string) => string | undefined) {
  const ws = words ?? [];
  const votes: Record<string, Record<string, number>> = {};
  for (const w of ws) {
    const t = turnAt(script, (w.start + w.end) / 2);
    if (!t || w.speaker == null) continue;
    (votes[w.speaker] ??= {})[t.speaker] = (votes[w.speaker]?.[t.speaker] ?? 0) + 1;
  }
  const mapping: Record<string, string> = {};
  for (const [label, v] of Object.entries(votes)) {
    const explicit = labelToTruth?.(label);
    mapping[label] = explicit ?? Object.entries(v).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "?";
  }
  let correct = 0;
  let scored = 0;
  for (const w of ws) {
    const t = turnAt(script, (w.start + w.end) / 2);
    if (!t || w.speaker == null) continue;
    scored++;
    if (mapping[w.speaker] === t.speaker) correct++;
  }
  return { labels: Object.keys(votes), mapping, votes, words: ws.length, scored, correct, accuracy: scored ? Math.round((correct / scored) * 1000) / 1000 : null };
}

/** Utterance segmentation vs script turns: count, and start/end offsets of best-overlap utterance. */
export function utteranceAlignment(utts: Utterance[] | null | undefined, script: DialogScript) {
  const us = utts ?? [];
  const rows = script.turns.map((t) => {
    let best: Utterance | undefined;
    let bestOv = 0;
    for (const u of us) {
      const ov = Math.min(u.end, t.end_ms) - Math.max(u.start, t.start_ms);
      if (ov > bestOv) {
        bestOv = ov;
        best = u;
      }
    }
    return { turn: t.index, truth: t.speaker, hyp: best?.speaker ?? null, dStart: best ? best.start - t.start_ms : null, dEnd: best ? best.end - t.end_ms : null };
  });
  const starts = rows.map((r) => (r.dStart === null ? null : Math.abs(r.dStart))).filter((x): x is number => x !== null);
  return {
    utterances: us.length,
    turns: script.turns.length,
    meanAbsStartMs: starts.length ? Math.round(starts.reduce((a, b) => a + b, 0) / starts.length) : null,
    maxAbsStartMs: starts.length ? Math.max(...starts) : null,
    rows,
  };
}

export function entitySummary(entities: Entity[] | null | undefined) {
  const es = entities ?? [];
  const byType: Record<string, string[]> = {};
  for (const e of es) (byType[e.entity_type] ??= []).push(e.text);
  const joined = es.map((e) => e.text).join(" | ");
  return { count: es.length, byType, factsInEntities: factsFound(joined) };
}

/** Which ground-truth facts survive in the redacted text vs the unredacted text. */
export function redactionReport(t: Transcript) {
  const red = factsFound(t.text);
  const un = factsFound(t.unredacted_text ?? null);
  const rows = FACT_CHECKS.map((f) => ({ fact: f.label, inUnredacted: un[f.key], inRedacted: red[f.key], redacted: !!un[f.key] && !red[f.key] }));
  const tags = [...new Set((t.text ?? "").match(/\[[A-Z_]+\]|#{2,}/g) ?? [])];
  return { tags, rows };
}

/**
 * Sentiment rows: speaker attribution vs truth (by sentence midpoint), leaked inline audio tags
 * ("[Speaker:1]") and PII that survives redaction.
 */
export function sentimentReport(t: Transcript, script: DialogScript, labelToTruth?: Record<string, string>) {
  const rows = t.sentiment_analysis_results ?? [];
  const mapping = labelToTruth ?? speakerAccuracy(t.unredacted_words ?? t.words, script).mapping;
  let scored = 0;
  let correct = 0;
  let nullSpeaker = 0;
  const wrong: Array<{ speaker: string | null; truth: string; text: string }> = [];
  for (const r of rows) {
    if (r.speaker == null) {
      nullSpeaker++;
      continue;
    }
    const tt = turnAt(script, (r.start + r.end) / 2);
    if (!tt) continue;
    scored++;
    if (mapping[r.speaker] === tt.speaker) correct++;
    else wrong.push({ speaker: r.speaker, truth: tt.speaker, text: r.text.slice(0, 60) });
  }
  const tagged = rows.filter((r) => /\[Speaker:[^\]]*\]/.test(r.text));
  const tagValues = [...new Set(rows.flatMap((r) => r.text.match(/\[Speaker:[^\]]*\]/g) ?? []))];
  const piiLeaks = factsFound(rows.map((r) => r.text).join(" "));
  return {
    rows: rows.length,
    nullSpeaker,
    scored,
    correct,
    speakerAccuracy: scored ? Math.round((correct / scored) * 1000) / 1000 : null,
    wrongSample: wrong.slice(0, 6),
    rowsWithInlineSpeakerTags: tagged.length,
    inlineTagValues: tagValues,
    factsVisibleInSentimentText: Object.entries(piiLeaks).filter(([, v]) => v).map(([k]) => k),
  };
}

/** Align two word lists by text and compare timings (e.g. multichannel vs mono of the same audio). */
export function compareWordTimings(a: Word[], b: Word[]) {
  let i = 0;
  let j = 0;
  const ds: number[] = [];
  const de: number[] = [];
  const durA: number[] = [];
  const durB: number[] = [];
  while (i < a.length && j < b.length) {
    const wa = a[i]!;
    const wb = b[j]!;
    if (norm(wa.text) === norm(wb.text)) {
      ds.push(Math.abs(wa.start - wb.start));
      de.push(Math.abs(wa.end - wb.end));
      durA.push(wa.end - wa.start);
      durB.push(wb.end - wb.start);
      i++;
      j++;
    } else if (i + 1 < a.length && norm(a[i + 1]!.text) === norm(wb.text)) i++;
    else j++;
  }
  const mean = (x: number[]): number => (x.length ? Math.round(x.reduce((p, q) => p + q, 0) / x.length) : 0);
  const median = (x: number[]): number => (x.length ? [...x].sort((p, q) => p - q)[Math.floor(x.length / 2)]! : 0);
  return {
    matched: ds.length,
    startDiffMeanMs: mean(ds),
    startDiffMedianMs: median(ds),
    endDiffMeanMs: mean(de),
    durationMedianA: median(durA),
    durationMedianB: median(durB),
    wordsExactly80msA: durA.filter((d) => d === 80).length,
  };
}

export function fullReport(t: Transcript, script = loadDialogScript()) {
  return {
    facts: factsFound(t.unredacted_text ?? t.text),
    speaker: speakerAccuracy(t.unredacted_words ?? t.words, script),
    utterances: utteranceAlignment(t.utterances, script),
  };
}
