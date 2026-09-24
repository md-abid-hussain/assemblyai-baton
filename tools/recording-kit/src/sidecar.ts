/**
 * sidecar.ts - the JSON written next to every downloaded recording (data/calls/raw/<base>.json),
 * plus the split step that turns the 2-channel WAV into per-role 8 kHz PCM16 files.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { RAW_DIR, SPLIT_DIR, fromRepoRel, repoRel } from "./paths.ts";
import type { FactField, FactValue, LoadedScenario, Status } from "./scenarios.ts";
import type { ResolvedParticipant } from "./participants.ts";
import { maskPhone } from "./phone.ts";
import { type ChannelStats, channelStats, decodeWav, deinterleave, encodeWavPcm16, formatName, overlapRatio, resample } from "./wav.ts";

export const SIDECAR_VERSION = 1;
export const OUTPUT_SAMPLE_RATE = 8000;

export type Role = "rep" | "customer";
/** Twilio channel numbering is 1-based: "1" = parent leg (party A), "2" = child leg (party B). */
export type ChannelMap = { "1": Role; "2": Role };

export interface SidecarParticipant {
  key: string;
  display_name: string;
  phone_masked: string;
  consent: ResolvedParticipant["consent"];
}

export interface Sidecar {
  kit: "baton-recording-kit";
  sidecar_version: number;
  base: string;
  created_at: string;
  updated_at: string;
  state: "call_placed" | "call_ended_no_recording" | "downloaded";
  scenario: { id: string; title: string; language: string; file: string; sha256: string } | null;
  take: number;
  review: {
    status: "unreviewed" | "keep" | "discard";
    notes: string[];
    /** Values actually said in the call when they differ from the scenario ground truth. */
    fact_overrides: Partial<Record<FactField, FactValue>>;
    /** Statuses at hand-off that ended up different from the scenario design. */
    status_overrides: Partial<Record<FactField, Status>>;
  };
  channel_map: ChannelMap;
  dialed_first: Role;
  participants: Partial<Record<Role, SidecarParticipant>>;
  consent: {
    all_recording_consent: boolean | null;
    /** true only when every participant's scope is "public". */
    publishable: boolean;
  };
  twilio: {
    call_sid: string;
    from_masked: string;
    time_limit_s: number | null;
    call_status?: string;
    call_duration_s?: number | null;
    call_start?: string | null;
    call_end?: string | null;
    child_calls?: { sid: string; status: string; duration_s: number | null }[];
    recording_sid?: string;
    recording_status?: string;
    recording_duration_s?: number | null;
    recording_channels?: number;
    recording_source?: string;
    recording_start?: string | null;
  };
  files?: { stereo: string; rep: string; customer: string };
  audio?: {
    source_sample_rate: number;
    source_channels: number;
    source_format: string;
    output_sample_rate: number;
    duration_s: number;
    channels: Record<Role, ChannelStats>;
    overlap_ratio: number;
    warnings: string[];
  };
}

export const sidecarPath = (base: string): string => resolve(RAW_DIR, `${base}.json`);
export const rawWavPath = (base: string): string => resolve(RAW_DIR, `${base}.wav`);
export const splitPath = (base: string, role: Role): string => resolve(SPLIT_DIR, `${base}_${role}.wav`);

export function readSidecar(base: string): Sidecar | null {
  const p = sidecarPath(base);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf8")) as Sidecar;
}

export function writeSidecar(sc: Sidecar): void {
  mkdirSync(RAW_DIR, { recursive: true });
  sc.updated_at = new Date().toISOString();
  writeFileSync(sidecarPath(sc.base), JSON.stringify(sc, null, 2) + "\n");
}

export function listSidecars(): Sidecar[] {
  if (!existsSync(RAW_DIR)) return [];
  return readdirSync(RAW_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => {
      try {
        return JSON.parse(readFileSync(resolve(RAW_DIR, f), "utf8")) as Sidecar;
      } catch {
        return null;
      }
    })
    .filter((x): x is Sidecar => x !== null && x.kit === "baton-recording-kit");
}

export function newSidecar(o: {
  base: string;
  scenario: LoadedScenario | null;
  take: number;
  dialedFirst: Role;
  channelMap: ChannelMap;
  participants: Partial<Record<Role, SidecarParticipant>>;
  callSid: string;
  fromMasked: string;
  timeLimitS: number | null;
}): Sidecar {
  const now = new Date().toISOString();
  return {
    kit: "baton-recording-kit",
    sidecar_version: SIDECAR_VERSION,
    base: o.base,
    created_at: now,
    updated_at: now,
    state: "call_placed",
    scenario: o.scenario
      ? { id: o.scenario.scenario.id, title: o.scenario.scenario.title, language: o.scenario.scenario.language, file: repoRel(o.scenario.file), sha256: o.scenario.sha256 }
      : null,
    take: o.take,
    review: { status: "unreviewed", notes: [], fact_overrides: {}, status_overrides: {} },
    channel_map: o.channelMap,
    dialed_first: o.dialedFirst,
    participants: o.participants,
    consent: consentSummary(o.participants),
    twilio: { call_sid: o.callSid, from_masked: o.fromMasked, time_limit_s: o.timeLimitS },
  };
}

export function nextTake(scenarioId: string): number {
  return listSidecars().filter((s) => s.scenario?.id === scenarioId).reduce((m, s) => Math.max(m, s.take), 0) + 1;
}

export function parseChannelMap(s: string): ChannelMap {
  const parts = s.split(",").map((x) => x.trim().toLowerCase());
  if (parts.length === 2 && parts[0] !== parts[1] && parts.every((p) => p === "rep" || p === "customer")) {
    return { "1": parts[0] as Role, "2": parts[1] as Role };
  }
  throw new Error(`--channel-map must be "rep,customer" or "customer,rep" (channel 1 first), got "${s}"`);
}

export function channelMapFor(dialedFirst: Role): ChannelMap {
  return dialedFirst === "rep" ? { "1": "rep", "2": "customer" } : { "1": "customer", "2": "rep" };
}

export function toSidecarParticipant(p: ResolvedParticipant): SidecarParticipant {
  return { key: p.key, display_name: p.displayName, phone_masked: maskPhone(p.phone), consent: p.consent };
}

export function consentSummary(parts: Partial<Record<Role, SidecarParticipant>>): Sidecar["consent"] {
  const list = [parts.rep, parts.customer];
  if (list.some((p) => !p)) return { all_recording_consent: null, publishable: false };
  return {
    all_recording_consent: list.every((p) => p!.consent.recording),
    publishable: list.every((p) => p!.consent.recording && p!.consent.scope === "public"),
  };
}

/**
 * Decode the 2-channel WAV, write <base>_rep.wav and <base>_customer.wav (mono, 8 kHz, PCM16),
 * measure levels and fill sidecar.files / sidecar.audio. Pure local work, no network.
 */
export function splitRecording(sc: Sidecar, stereoWavBytes: Uint8Array): Sidecar {
  const wav = decodeWav(stereoWavBytes);
  const warnings: string[] = [];
  let chans: Int16Array[];
  if (wav.channels === 2) {
    chans = deinterleave(wav.samples, 2);
  } else if (wav.channels === 1) {
    warnings.push("recording is MONO, not dual-channel: both split files contain the mixed audio (check the Dial record attribute)");
    chans = [wav.samples, wav.samples];
  } else {
    throw new Error(`expected a 2-channel recording, got ${wav.channels} channels`);
  }
  const rate = wav.sampleRate;
  if (rate !== OUTPUT_SAMPLE_RATE) {
    warnings.push(`source sample rate was ${rate} Hz; resampled to ${OUTPUT_SAMPLE_RATE} Hz`);
    chans = chans.map((c) => resample(c, rate, OUTPUT_SAMPLE_RATE));
  }
  mkdirSync(SPLIT_DIR, { recursive: true });
  const byRole: Record<Role, Int16Array> = { rep: new Int16Array(0), customer: new Int16Array(0) };
  byRole[sc.channel_map["1"]] = chans[0]!;
  byRole[sc.channel_map["2"]] = chans[1]!;
  for (const role of ["rep", "customer"] as const) {
    writeFileSync(splitPath(sc.base, role), encodeWavPcm16(byRole[role], OUTPUT_SAMPLE_RATE, 1));
  }
  const rep = channelStats(byRole.rep, OUTPUT_SAMPLE_RATE);
  const cust = channelStats(byRole.customer, OUTPUT_SAMPLE_RATE);
  const overlap = overlapRatio(rep.activity, cust.activity);
  const duration = Math.round(wav.durationS * 10) / 10;

  for (const [role, st] of [["rep", rep.stats], ["customer", cust.stats]] as const) {
    if (st.active_ratio < 0.03) warnings.push(`${role} channel is nearly silent (${Math.round(st.active_ratio * 100)}% speech) - was that phone muted, or is the channel map wrong?`);
    if (st.clipped_ratio > 0.005) warnings.push(`${role} channel clips (${(st.clipped_ratio * 100).toFixed(1)}% of samples) - speak a bit further from the mic`);
  }
  if (duration < 45) warnings.push(`only ${duration}s long - probably incomplete (targets are 60-150 s)`);
  if (duration > 170) warnings.push(`${duration}s long - over the 150 s target`);
  if (overlap > 0.25) warnings.push(`both channels active ${Math.round(overlap * 100)}% of the talk time - heavy crosstalk, or the two phones were in the same room (audio bleed)`);

  sc.files = {
    stereo: repoRel(rawWavPath(sc.base)),
    rep: repoRel(splitPath(sc.base, "rep")),
    customer: repoRel(splitPath(sc.base, "customer")),
  };
  sc.audio = {
    source_sample_rate: rate,
    source_channels: wav.channels,
    source_format: formatName(wav.formatTag, wav.sourceBits),
    output_sample_rate: OUTPUT_SAMPLE_RATE,
    duration_s: duration,
    channels: { rep: rep.stats, customer: cust.stats },
    overlap_ratio: overlap,
    warnings,
  };
  sc.state = "downloaded";
  return sc;
}

/** Find a sidecar by exact base, by path to its .wav/.json, or by a unique scenario id prefix ("s03"). */
export function resolveBase(ref: string): string {
  const stripped = ref.replace(/^.*[\\/]/, "").replace(/(_rep|_customer)?\.(wav|json)$/i, "");
  if (existsSync(sidecarPath(stripped)) || existsSync(rawWavPath(stripped))) return stripped;
  const hits = listSidecars().filter((s) => s.base.startsWith(stripped));
  if (hits.length === 1) return hits[0]!.base;
  if (hits.length > 1) throw new Error(`"${ref}" matches ${hits.length} recordings: ${hits.map((h) => h.base).join(", ")} - use the full name`);
  throw new Error(`no recording found for "${ref}" in ${repoRel(RAW_DIR)}`);
}

export function absFromSidecarFile(p: string): string {
  return fromRepoRel(p);
}
