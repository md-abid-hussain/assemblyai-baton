/**
 * scenario/sim-take.ts - a SIMULATED take in the recording-kit's own format (WP9·2 fallback), pure.
 *
 * The flagship path (Watch → Express → pass) needs one featured s01 take with assets, a hand-off label and cached
 * turns. Until the recording session happens there is no real take, so `scripts/calls/sim-take.ts` generates one:
 * OpenAI writes the two-party script (PLATFORM P7), two distinct TTS voices speak it, and this module lays the clips
 * out on a call clock and assembles per-channel 8 kHz PCM16 - byte-compatible with what the kit writes, so
 * `calls:build`, the STT cache runner and the labeller treat it exactly like a recording.
 *
 * It is never passed off as a recording:
 *   - the sidecar carries `provenance.kind = "simulated"` (`kit.ts`), which `calls:build` turns into
 *     `src/generated/call-provenance.json` → the provenance strip's `humanHalf: "simulated"` (PLATFORM §7.6);
 *   - the labels are written with `reviewed: false`, so a simulated take is never `inEval` and never contributes a
 *     number to the deck (JP-I3: "n runs over k distinct RECORDED takes");
 *   - `loadKit` drops it the moment a real, usable take of the same scenario exists.
 *
 * Timings here are exact by construction (we place the clips), so the hand-off label - including `acceptStartMs`,
 * which Express needs - costs nothing and needs no human review. Word-level `mentions` are NOT invented: the
 * labeller is the only thing allowed to produce those.
 */
import { z } from "zod";

import { concatPcm16 } from "../audio/pcm";
import { resampleLinear } from "../audio/resample";
import type { CallLabels } from "../contracts/scenario";
import { KIT_ROLES, type KitRole, type KitScenario, type KitSidecar } from "./kit";

// ------------------------------------------------------------------------------------------------ constants

/** The models the sim is allowed to use (research/10 §3.2, §3.9; PLATFORM §7.5.3). */
export const SIM_SCRIPT_MODEL = "gpt-6-luna";
export const SIM_TTS_MODEL = "gpt-4o-mini-tts-2025-12-15";

/** Two clearly different voices, one per leg (research/10 §3.2: only these two are supported). */
export const SIM_VOICES: Readonly<Record<KitRole, string>> = { rep: "cedar", customer: "marin" };

/** The provenance strip's detail line for a simulated human half, verbatim from PLATFORM §7.5.3. */
export const SIM_PROVENANCE_DETAIL = "Simulated audio: script by gpt-6-luna, voices by gpt-4o-mini-tts. Fictional people.";

/** The detail line of a real recorded take (DESIGN/PLATFORM §1.2: consented volunteers over a real phone line). */
export const RECORDED_PROVENANCE_DETAIL = "Recorded role-play call over a real phone line. Consented volunteers, fictional policies.";

/** Twilio's telephony rate: the kit's split WAVs and every asset are 8 kHz. */
export const SIM_RATE = 8000;
/** OpenAI TTS returns PCM16 mono at this rate (research/10 §3.9). */
export const SIM_TTS_RATE = 24_000;

/** Silence before the first word, after the last one, and the nominal gap between turns. */
export const SIM_LEAD_MS = 400;
export const SIM_TAIL_MS = 900;
export const SIM_GAP_MS = 320;
/** Deterministic ± jitter on the gap, so the call does not sound metronomic. */
export const SIM_GAP_JITTER_MS = 140;

/** Peak the assembled channels are normalized to (real Twilio takes sit near -3 dBFS peak). */
export const SIM_TARGET_PEAK_DBFS = -3;

// ------------------------------------------------------------------------------------------------ the script

export const SimTurnSchema = z.object({
  /** The `talk_track` beat this turn plays (0 when the model added a filler turn). */
  beat: z.number().int().nonnegative(),
  who: z.enum(KIT_ROLES),
  text: z.string().min(1).max(400),
});
export type SimTurn = z.infer<typeof SimTurnSchema>;

export const SimScriptSchema = z.object({
  scenarioId: z.string(),
  turns: z.array(SimTurnSchema).min(6).max(40),
});
export type SimScript = z.infer<typeof SimScriptSchema>;

/** Strict-mode JSON schema for `extractStructured` (every key required, additionalProperties false). */
export const SIM_SCRIPT_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["scenarioId", "turns"],
  properties: {
    scenarioId: { type: "string" },
    turns: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["beat", "who", "text"],
        properties: {
          beat: { type: "integer", description: "the talk_track beat number this turn plays" },
          who: { type: "string", enum: [...KIT_ROLES] },
          text: { type: "string", description: "exactly what this person says out loud, no stage directions" },
        },
      },
    },
  },
};

export const SIM_SCRIPT_INSTRUCTIONS = [
  "You write the spoken dialogue of a role-play customer-service phone call, for a product demo.",
  "Everyone and every policy in it is fictional. Write only what is said out loud: no names of speakers, no stage",
  "directions, no markdown, no numbered lists, no emoji.",
  "",
  "Rules:",
  "1. Follow the talk_track beats in order, one turn per beat; give each turn its beat number. You may split a long",
  "   beat into two turns with the same beat number, but never reorder or skip a beat.",
  "2. Every fact listed on a beat must be said out loud in that turn, using the fact's `say_it` wording where it",
  "   reads naturally. Numbers, dates, spellings and money amounts must match the facts exactly.",
  "3. Sound like two real people on the phone: contractions, short sentences, an occasional 'okay' or 'right'.",
  "   Do not write filler that carries no information, and never let either party ramble.",
  "4. The hand-off beat's rep turn is supplied verbatim; reproduce it word for word.",
  "5. Keep each turn under 320 characters, and the whole call inside its target duration.",
].join("\n");

/** The `input` for the script call: the scenario, reduced to what the writer needs. */
export function simScriptInput(scenario: KitScenario, o: { targetSeconds: number }): string {
  const s = scenario as KitScenario & Record<string, unknown>;
  const pick = <T>(k: string): T | undefined => s[k] as T | undefined;
  const brief = {
    scenarioId: scenario.id,
    title: scenario.title,
    language: scenario.language,
    target_duration_s: o.targetSeconds,
    rep: scenario.rep,
    customer: { ...scenario.customer, persona: pick<string>("customer") },
    facts: scenario.facts,
    advice: pick("advice") ?? [],
    talk_track: pick("talk_track") ?? [],
    handoff: scenario.handoff,
    directions: pick("directions") ?? {},
  };
  return [
    `Write the spoken dialogue for scenario ${scenario.id} ("${scenario.title}").`,
    `The rep speaks as ${scenario.rep.name} of ${scenario.rep.agency}; the customer speaks as ${scenario.customer.name}.`,
    scenario.handoff ? `The rep's hand-off line, verbatim: "${scenario.handoff.line}"` : "",
    scenario.handoff?.customer_says ? `The customer answers it with something close to: "${scenario.handoff.customer_says}"` : "",
    "",
    JSON.stringify(brief),
  ]
    .filter(Boolean)
    .join("\n");
}

// ------------------------------------------------------------------------------------------------ repair

export interface SimScriptCheck {
  script: SimScript;
  /** Repairs applied to what the model returned (each one is reported by the script and logged in the notes). */
  repairs: string[];
  handoffIndex: number;
  acceptIndex: number | null;
}

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/**
 * Make the script usable without trusting the model on the two things the demo depends on: the hand-off line is
 * forced to the scenario's exact wording, and the customer's acceptance is guaranteed to be the next turn.
 */
export function enforceHandoff(script: SimScript, scenario: KitScenario): SimScriptCheck {
  const repairs: string[] = [];
  const turns = script.turns.map((t) => ({ ...t, text: t.text.replace(/\s+/g, " ").trim() }));
  const handoff = scenario.handoff;
  if (!handoff) throw new Error(`${scenario.id}: scenario has no handoff block; cannot build a simulated take`);
  const line = handoff.line;

  // The hand-off turn: the rep turn on the hand-off beat, else the rep turn whose text is closest to the line.
  let hi = turns.findIndex((t) => t.who === "rep" && t.beat === handoff.at_beat);
  if (hi < 0) {
    const wanted = norm(line);
    hi = turns.findIndex((t) => t.who === "rep" && (norm(t.text) === wanted || norm(t.text).includes(norm(line.slice(0, 24)))));
  }
  if (hi < 0) {
    // Last resort: insert it before the final rep turn, so the call still has a hand-off.
    hi = Math.max(0, turns.length - 2);
    turns.splice(hi, 0, { beat: handoff.at_beat ?? 0, who: "rep", text: line });
    repairs.push("hand-off turn was missing; inserted");
  }
  if (turns[hi]!.text !== line) {
    repairs.push(`hand-off line replaced with the scenario's exact wording (model wrote: "${turns[hi]!.text.slice(0, 60)}")`);
    turns[hi] = { ...turns[hi]!, text: line };
  }

  // The acceptance: the next customer turn. `declines`/`silent` scenarios get no acceptance label.
  let ai: number | null = null;
  if (handoff.customer_response === "accepts") {
    const next = turns.findIndex((t, i) => i > hi && t.who === "customer");
    if (next < 0) {
      turns.splice(hi + 1, 0, { beat: handoff.at_beat ?? 0, who: "customer", text: handoff.customer_says ?? "Sure, go ahead." });
      ai = hi + 1;
      repairs.push("acceptance turn was missing; inserted");
    } else if (next !== hi + 1) {
      const [t] = turns.splice(next, 1);
      turns.splice(hi + 1, 0, t!);
      ai = hi + 1;
      repairs.push("acceptance turn moved to directly after the hand-off");
    } else ai = next;
  }
  return { script: { ...script, turns }, repairs, handoffIndex: hi, acceptIndex: ai };
}

// ------------------------------------------------------------------------------------------------ timeline

export interface SimClip {
  /** PCM16 mono at `rate` (the raw TTS output; `simChannelsOf` resamples to 8 kHz). */
  samples: Int16Array;
  rate: number;
}

export interface SimPlacedTurn extends SimTurn {
  index: number;
  startMs: number;
  endMs: number;
}

export interface SimTimeline {
  turns: SimPlacedTurn[];
  totalMs: number;
}

/** Reproducible jitter: a 32-bit LCG over the turn index (no Math.random anywhere in the pipeline). */
const jitterMs = (i: number, amplitude: number): number => {
  const x = Math.imul(i + 1, 1_664_525) + 1_013_904_223;
  return Math.round(((((x >>> 8) % 2001) / 1000) - 1) * amplitude);
};

export interface TimelineOptions {
  leadMs?: number;
  tailMs?: number;
  gapMs?: number;
  jitterAmplitudeMs?: number;
}

/** Lay the clips out back to back on one call clock: lead silence, then turn + gap, then tail silence. */
export function planSimTimeline(turns: readonly SimTurn[], clipMs: readonly number[], o: TimelineOptions = {}): SimTimeline {
  if (turns.length !== clipMs.length) throw new Error(`planSimTimeline: ${turns.length} turns but ${clipMs.length} clips`);
  const lead = o.leadMs ?? SIM_LEAD_MS;
  const gap = o.gapMs ?? SIM_GAP_MS;
  const amp = o.jitterAmplitudeMs ?? SIM_GAP_JITTER_MS;
  const placed: SimPlacedTurn[] = [];
  let at = lead;
  for (let i = 0; i < turns.length; i++) {
    const startMs = at;
    const endMs = startMs + clipMs[i]!;
    placed.push({ ...turns[i]!, index: i, startMs, endMs });
    at = endMs + Math.max(80, gap + jitterMs(i, amp));
  }
  const last = placed.at(-1);
  return { turns: placed, totalMs: (last ? last.endMs : lead) + (o.tailMs ?? SIM_TAIL_MS) };
}

// ------------------------------------------------------------------------------------------------ assembly

const dbfsToGain = (db: number): number => 10 ** (db / 20);

/** Scale so the loudest sample sits at `peakDbfs`. A silent channel is returned unchanged. */
export function normalizePeak(samples: Int16Array, peakDbfs: number): Int16Array {
  let peak = 0;
  for (const s of samples) {
    const a = s < 0 ? -s : s;
    if (a > peak) peak = a;
  }
  if (peak === 0) return samples;
  const gain = (dbfsToGain(peakDbfs) * 32_767) / peak;
  if (Math.abs(gain - 1) < 0.01) return samples;
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.round(samples[i]! * gain);
    out[i] = v > 32_767 ? 32_767 : v < -32_768 ? -32_768 : v;
  }
  return out;
}

export interface SimChannels {
  rep: Int16Array;
  customer: Int16Array;
  sampleRate: number;
}

/**
 * Write every clip onto its own channel at its placed offset: the rep leg and the customer leg never share a
 * channel, exactly as Twilio records a `<Dial record="record-from-answer-dual">` call.
 */
export function simChannelsOf(timeline: SimTimeline, clips: readonly SimClip[], o: { peakDbfs?: number } = {}): SimChannels {
  const n = Math.ceil((timeline.totalMs * SIM_RATE) / 1000);
  const chans: Record<KitRole, Int16Array> = { rep: new Int16Array(n), customer: new Int16Array(n) };
  for (const t of timeline.turns) {
    const clip = clips[t.index];
    if (!clip) throw new Error(`simChannelsOf: no clip for turn ${t.index}`);
    const at8k = clip.rate === SIM_RATE ? clip.samples : resampleLinear(clip.samples, clip.rate, SIM_RATE);
    const off = Math.round((t.startMs * SIM_RATE) / 1000);
    const room = n - off;
    chans[t.who].set(at8k.length > room ? at8k.subarray(0, Math.max(0, room)) : at8k, off);
  }
  const peak = o.peakDbfs ?? SIM_TARGET_PEAK_DBFS;
  return { rep: normalizePeak(chans.rep, peak), customer: normalizePeak(chans.customer, peak), sampleRate: SIM_RATE };
}

/** Interleave the two channels into the stereo "raw" recording the kit downloads from Twilio (ch1 rep, ch2 customer). */
export function simStereoOf(c: SimChannels): Int16Array {
  const out = new Int16Array(c.rep.length * 2);
  for (let i = 0; i < c.rep.length; i++) {
    out[i * 2] = c.rep[i]!;
    out[i * 2 + 1] = c.customer[i]!;
  }
  return out;
}

/** Trim leading/trailing digital silence from a TTS clip so the planned gaps are the gaps you hear. */
export function trimClip(samples: Int16Array, o: { thresholdDbfs?: number; keepMs?: number; rate?: number } = {}): Int16Array {
  const rate = o.rate ?? SIM_TTS_RATE;
  const threshold = dbfsToGain(o.thresholdDbfs ?? -45) * 32_767;
  const keep = Math.round(((o.keepMs ?? 30) * rate) / 1000);
  let start = 0;
  let end = samples.length;
  while (start < end && Math.abs(samples[start]!) < threshold) start++;
  while (end > start && Math.abs(samples[end - 1]!) < threshold) end--;
  if (start >= end) return new Int16Array(0);
  return samples.slice(Math.max(0, start - keep), Math.min(samples.length, end + keep));
}

export const clipDurationMs = (samples: Int16Array, rate: number): number => Math.round((samples.length / rate) * 1000);

/** Concatenate PCM chunks from the TTS stream into one clip (re-exported so the script keeps one audio import). */
export const joinPcm = (parts: readonly Int16Array[]): Int16Array => concatPcm16([...parts]);

// ------------------------------------------------------------------------------------------------ sidecar + labels

export interface SimSidecarOptions {
  scenario: KitScenario;
  base: string;
  take: number;
  /** ISO; also the sidecar's created_at/updated_at, so rebuilds are byte-identical. */
  at: string;
  durationMs: number;
  scenarioSha256: string;
  publishable?: boolean;
  voices?: Readonly<Record<KitRole, string>>;
  scriptModel?: string;
  ttsModel?: string;
  rmsDbfs: Record<KitRole, number>;
  peakDbfs: Record<KitRole, number>;
  /** Where the files live, relative to the repo (`data/sim-takes/...`). */
  fileDir: string;
}

/**
 * A kit sidecar for a generated take. `provenance` is WP9's own addition (the recording kit never writes it), and
 * `review.notes` repeats it in plain words so nobody reading the file can miss what this is.
 */
export function simSidecar(o: SimSidecarOptions): KitSidecar {
  const publishable = o.publishable ?? true;
  const durationS = Math.round(o.durationMs / 100) / 10;
  const voices = o.voices ?? SIM_VOICES;
  const party = (role: KitRole) => ({
    key: `simulated-${role}`,
    display_name: role === "rep" ? o.scenario.rep.name : o.scenario.customer.name,
    phone_masked: null,
    consent: { recording: true, scope: "public" },
    voice: voices[role],
  });
  const stats = (role: KitRole) => ({
    rms_dbfs: o.rmsDbfs[role],
    peak_dbfs: o.peakDbfs[role],
    active_ratio: null,
    first_active_s: null,
    clipped_ratio: 0,
  });
  return {
    kit: "baton-recording-kit",
    sidecar_version: 1,
    base: o.base,
    created_at: o.at,
    updated_at: o.at,
    state: "downloaded",
    provenance: {
      kind: "simulated",
      detail: SIM_PROVENANCE_DETAIL,
      script_model: o.scriptModel ?? SIM_SCRIPT_MODEL,
      tts_model: o.ttsModel ?? SIM_TTS_MODEL,
      voices: { rep: voices.rep, customer: voices.customer },
      generated_at: o.at,
      replaced_by_real_takes: true,
    },
    scenario: { id: o.scenario.id, title: o.scenario.title, language: o.scenario.language, file: `data/scenarios/${o.scenario.id}.json`, sha256: o.scenarioSha256 },
    take: o.take,
    review: {
      status: "keep",
      notes: [
        "SIMULATED take: no human was recorded.",
        SIM_PROVENANCE_DETAIL,
        "It is a stand-in for the flagship path and is dropped automatically as soon as a real take of this scenario exists.",
      ],
      fact_overrides: {},
      status_overrides: {},
    },
    channel_map: { "1": "rep", "2": "customer" },
    dialed_first: "rep",
    participants: { rep: party("rep"), customer: party("customer") },
    consent: { all_recording_consent: true, publishable },
    // No phone call happened. The block is kept because the kit format requires it, with explicit nulls where a real
    // take carries Twilio ids; `recording_channels: 2` is literally true of the audio next to it, which is what the
    // build's channel-separation rule (`isDualChannel`) asks about.
    twilio: {
      call_sid: null,
      from_masked: null,
      call_status: null,
      recording_sid: null,
      recording_status: null,
      recording_duration_s: durationS,
      recording_channels: 2,
      recording_source: "simulated",
    },
    files: {
      stereo: `${o.fileDir}/raw/${o.base}.wav`,
      rep: `${o.fileDir}/split/${o.base}_rep.wav`,
      customer: `${o.fileDir}/split/${o.base}_customer.wav`,
    },
    audio: {
      source_sample_rate: SIM_TTS_RATE,
      source_channels: 2,
      source_format: "PCM 16-bit",
      output_sample_rate: SIM_RATE,
      duration_s: durationS,
      channels: { rep: stats("rep"), customer: stats("customer") },
      overlap_ratio: 0,
      warnings: [],
    },
  } as unknown as KitSidecar;
}

/**
 * Labels straight off the timeline. Exact, so no human review is needed - but `reviewed` stays false, because a
 * simulated take must never enter the eval set (`inEval` requires `reviewed`).
 */
export function simLabels(callId: string, t: SimTimeline, handoffIndex: number, acceptIndex: number | null): CallLabels {
  const h = t.turns[handoffIndex];
  if (!h) throw new Error(`simLabels: no turn at hand-off index ${handoffIndex}`);
  const a = acceptIndex === null ? null : t.turns[acceptIndex] ?? null;
  return {
    callId,
    reviewed: false,
    mentions: [],
    handoff: { lineStartMs: h.startMs, lineEndMs: h.endMs, acceptStartMs: a?.startMs ?? null, acceptEndMs: a?.endMs ?? null },
    diagnosisEndsMs: null,
    tailStartsMs: a ? a.endMs : h.endMs,
  };
}

/** `<scenarioId>_sim_<compact utc>`: sorts and reads like a kit base, and never collides with WP17's `sim-*` ids. */
export const simBase = (scenarioId: string, at: string): string =>
  `${scenarioId}_sim_${new Date(at).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z")}`;
