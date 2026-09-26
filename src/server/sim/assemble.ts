/**
 * server/sim/assemble.ts - the simulated-call assembler (PLATFORM §7.5 step 3; WP17·1). Pure and deterministic:
 * the same script, clips and seed give byte-identical output (build-gallery acceptance 1).
 *
 *   planSimLines(script, {repLine})   normalize a `sim_script` for voicing: the handoff turn becomes the EXACT
 *                                     `handoff.repLine`, the customer's acceptance must follow it, and anything after
 *                                     the acceptance is dropped (the AI half is live, not scripted)
 *   assembleSimCall(lines, {seed})    24 kHz TTS clips → trim edge silence → resample to 8 kHz (the existing
 *                                     `core/audio/resample`) → mu-law; lines laid on one timeline: 0.8 s lead-in, a
 *                                     seeded 350–650 ms gap between turns, 300 ms between the handoff line and the
 *                                     acceptance, 1 s tail; the other channel is mu-law silence (0xFF). Returns both
 *                                     channels, the 50/s peaks, the handoff times and the timeline. Cap 90 s.
 */
import "server-only";

import { createHash } from "node:crypto";

import { bytesToPcm16, MULAW_SILENCE, mulawDecode, mulawEncode, resampleLinear, trimSilence } from "../../core/audio";
import { SIM_TIMELINE, SIM_VOICES, type SimSpeaker, type SimTimelineTurn, type SimTurnTag } from "../../core/contracts/ext/wp17-sim";
import type { CallHandoff, Peaks } from "../../core/contracts/scenario";
import type { SimScript } from "../../core/contracts/v2/api";

const SRC_RATE = 24_000;
const OUT_RATE = SIM_TIMELINE.sampleRate;
const MIN_TURNS = 8;
export const PEAKS_PER_SEC = 50;

export type SimScriptErrorCode = "first_not_rep" | "no_handoff" | "handoff_not_rep" | "no_accept" | "empty_line" | "too_short";

/** The script cannot be voiced as-is (the script step regenerates once; PLATFORM §7.5 step 1). */
export class SimScriptError extends Error {
  constructor(readonly code: SimScriptErrorCode, message: string) {
    super(message);
    this.name = "SimScriptError";
  }
}

/** The assembled human half exceeds the 90 s cap. */
export class SimTooLongError extends Error {
  constructor(readonly durationMs: number, readonly maxMs: number) {
    super(`simulated call is ${Math.round(durationMs)} ms (cap ${maxMs} ms)`);
    this.name = "SimTooLongError";
  }
}

export interface SimLinePlan {
  i: number;
  speaker: SimSpeaker;
  tag: SimTurnTag;
  text: string;
  voice: string;
}

const clean = (s: string): string => s.replace(/\s+/g, " ").trim();

/** Normalize a script for voicing (see the header). Throws `SimScriptError`. */
export function planSimLines(script: SimScript, handoff: { repLine: string }): { script: SimScript; lines: SimLinePlan[] } {
  const turns = script.turns.map((t) => ({ ...t, text: clean(t.text) }));
  if (turns[0]?.speaker !== "rep") throw new SimScriptError("first_not_rep", "the first turn must be the rep's");
  const h = turns.findIndex((t) => t.tag === "handoff");
  if (h < 0) throw new SimScriptError("no_handoff", "no turn is tagged handoff");
  if (turns[h]!.speaker !== "rep") throw new SimScriptError("handoff_not_rep", "the handoff turn must be the rep's");
  const a = turns[h + 1];
  if (!a || a.speaker !== "customer" || a.tag !== "accept") throw new SimScriptError("no_accept", "the customer's acceptance must follow the handoff line");
  const repLine = clean(handoff.repLine);
  if (!repLine) throw new SimScriptError("empty_line", "the relay's handoff line is empty");
  turns[h] = { ...turns[h]!, text: repLine };
  const kept = turns.slice(0, h + 2);
  if (kept.length < MIN_TURNS) throw new SimScriptError("too_short", `only ${kept.length} turns up to the acceptance (need ${MIN_TURNS})`);
  const empty = kept.findIndex((t) => !t.text);
  if (empty >= 0) throw new SimScriptError("empty_line", `turn ${empty} is empty`);
  return {
    script: { ...script, turns: kept },
    lines: kept.map((t, i) => ({ i, speaker: t.speaker, tag: t.tag, text: t.text, voice: SIM_VOICES[t.speaker] })),
  };
}

export interface SimLineAudio {
  speaker: SimSpeaker;
  tag: SimTurnTag;
  text: string;
  /** PCM16 LE mono @ 24 kHz (a TTS clip). */
  pcm24k: Uint8Array;
  /** tts_cache hash of the clip. */
  clipHash: string;
}

export interface AssembledSimCall {
  /** Raw 8 kHz mu-law, one channel each, equal length. */
  rep: Uint8Array;
  customer: Uint8Array;
  peaks: Peaks;
  durationMs: number;
  handoff: CallHandoff;
  timeline: SimTimelineTurn[];
}

export type SimTimelineOptions = { -readonly [K in keyof typeof SIM_TIMELINE]?: number };

/** mulberry32 seeded from sha256(seed): a small deterministic PRNG for the gaps. */
export function seededRandom(seed: string): () => number {
  let a = createHash("sha256").update(seed, "utf8").digest().readUInt32LE(0);
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Max-abs / 32768 per 20 ms window, 3 decimals (the `peaks.json` format, DESIGN §5.1.1). */
export function computePeaks(samples: Int16Array, sampleRate: number, ratePerSec = PEAKS_PER_SEC): number[] {
  const win = Math.round(sampleRate / ratePerSec);
  const n = Math.ceil(samples.length / win);
  const out = new Array<number>(n);
  for (let w = 0; w < n; w++) {
    let max = 0;
    const end = Math.min(samples.length, (w + 1) * win);
    for (let i = w * win; i < end; i++) {
      const v = samples[i]!;
      const abs = v < 0 ? -v : v;
      if (abs > max) max = abs;
    }
    out[w] = Math.min(1, Math.round((max / 32768) * 1000) / 1000);
  }
  return out;
}

/** 24 kHz TTS clip → trimmed 8 kHz mu-law. */
export function clipToMulaw8k(pcm24k: Uint8Array): Uint8Array {
  const samples = bytesToPcm16(pcm24k);
  const trimmed = trimSilence(samples, SRC_RATE, { thresholdDb: -50, padMs: 30 }).samples;
  const use = trimmed.length > 0 ? trimmed : samples;
  return mulawEncode(resampleLinear(use, SRC_RATE, OUT_RATE));
}

const msToSamples = (ms: number): number => Math.round((ms * OUT_RATE) / 1000);
const samplesToMs = (n: number): number => Math.round((n * 1000) / OUT_RATE);

/** Lay voiced lines on a two-channel timeline. Throws `SimScriptError` / `SimTooLongError`. */
export function assembleSimCall(lines: readonly SimLineAudio[], o: { seed: string; timeline?: SimTimelineOptions }): AssembledSimCall {
  const cfg = { ...SIM_TIMELINE, ...o.timeline };
  const h = lines.findIndex((l) => l.tag === "handoff");
  if (h < 0 || lines[h]!.speaker !== "rep") throw new SimScriptError("no_handoff", "no rep line is tagged handoff");
  if (lines[h + 1]?.tag !== "accept" || lines[h + 1]!.speaker !== "customer") throw new SimScriptError("no_accept", "the acceptance must follow the handoff line");

  const rand = seededRandom(o.seed);
  const encoded = lines.map((l) => clipToMulaw8k(l.pcm24k));
  const placed: { start: number; end: number }[] = [];
  let cursor = msToSamples(cfg.leadInMs);
  for (let i = 0; i < lines.length; i++) {
    if (i > 0) {
      const handoffGap = lines[i - 1]!.tag === "handoff" && lines[i]!.tag === "accept";
      const gapMs = handoffGap ? cfg.handoffGapMs : cfg.gapMinMs + Math.floor(rand() * (cfg.gapMaxMs - cfg.gapMinMs + 1));
      cursor += msToSamples(gapMs);
    }
    const len = encoded[i]!.length;
    placed.push({ start: cursor, end: cursor + len });
    cursor += len;
  }
  const total = cursor + msToSamples(cfg.tailMs);
  const durationMs = samplesToMs(total);
  if (durationMs > cfg.maxMs) throw new SimTooLongError(durationMs, cfg.maxMs);

  const rep = new Uint8Array(total).fill(MULAW_SILENCE);
  const customer = new Uint8Array(total).fill(MULAW_SILENCE);
  const timeline: SimTimelineTurn[] = lines.map((l, i) => {
    const p = placed[i]!;
    (l.speaker === "rep" ? rep : customer).set(encoded[i]!, p.start);
    return { i, speaker: l.speaker, tag: l.tag, text: l.text, startMs: samplesToMs(p.start), endMs: samplesToMs(p.end), clipHash: l.clipHash };
  });
  const line = timeline[h]!;
  const accept = timeline[h + 1]!;
  return {
    rep,
    customer,
    peaks: { ratePerSec: PEAKS_PER_SEC, rep: computePeaks(mulawDecode(rep), OUT_RATE), customer: computePeaks(mulawDecode(customer), OUT_RATE) },
    durationMs,
    handoff: { lineStartMs: line.startMs, lineEndMs: line.endMs, acceptStartMs: accept.startMs, acceptEndMs: accept.endMs, declined: false },
    timeline,
  };
}
