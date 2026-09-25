/**
 * stt-params.ts - the per-channel Streaming STT parameters of a recorded-call replay (DESIGN §5.1.5; owned by WP4).
 *
 * Pure: the server's route #5 (WP2) and the Node Day-1 scripts call `buildSttParams` to build the exact query of
 * each channel's session; the browser only receives the result. Nothing here reads the environment.
 *
 * - No `speaker_labels`, no `redact_pii`, no `llm_gateway` (DESIGN §5.1.5, research 10 §0).
 * - `keyterms_prompt` and `prompt` are NOT echoed by `Begin` (10b ST-9), so the URL query is pinned by a snapshot test
 *   (tests/unit/client/stt/stt-params.test.ts).
 * - `TUNING_8K` is the outcome of T-D1-6 (docs/notes/wp4.md); `TUNING_8K_GRID` is the v1.1 grid it was chosen from.
 */
import type { Channel, PolicyRecord } from "../contracts/case";
import type { CallManifestEntry } from "../contracts/scenario";
import { LIMITS, sanitizeParams, type BeginMessage, type StreamingParams } from "./streaming";

/** The only model the product streams with (10b ST-1). */
export const STT_SPEECH_MODEL = "universal-3-5-pro" as const;
/** Turn mode of every shadowing session (fast partials; final latency and WER are unchanged vs balanced, 10b ST-4). */
export const STT_MODE = "min_latency" as const;
/** Server-side safety net: an idle session closes with 3006 "inactivity" after this many seconds (DESIGN §5.1.9). */
export const STT_INACTIVITY_TIMEOUT_S = 30;

/** DESIGN §5.1.5, verbatim (≤ 1750 chars). */
export const STT_PROMPT =
  "Recorded phone call at a US insurance agency. A customer service representative and a policyholder discuss adding a driver to a personal auto policy: people's names, relationship, age or date of birth, learner's permit or driver's license, vehicle year make and model, ZIP codes, effective dates, and monthly premiums in dollars.";

/** The fixed domain keyterms appended to every policy's list (DESIGN §5.1.5). */
export const STT_FIXED_KEYTERMS = [
  "learner's permit",
  "probationary license",
  "endorsement",
  "garaging",
  "premium",
  "liability limits",
  "good student discount",
  "driver's ed",
] as const;

export type TurnTuning = Required<Pick<StreamingParams, "min_turn_silence" | "max_turn_silence">>;

/**
 * T-D1-6 grid (v1.1): min_turn_silence ∈ {160, 400} × max_turn_silence ∈ {1000, 2400}, on 2 real 8 kHz takes.
 */
export const TUNING_8K_GRID: readonly TurnTuning[] = [
  { min_turn_silence: 160, max_turn_silence: 1000 },
  { min_turn_silence: 160, max_turn_silence: 2400 },
  { min_turn_silence: 400, max_turn_silence: 1000 },
  { min_turn_silence: 400, max_turn_silence: 2400 },
];

/**
 * The 8 kHz µ-law turn tuning (DAY-1 TEST T-D1-6). PROVISIONAL: chosen from the reduced proxy grid on the TTS
 * fixture's µ-law derivative (docs/notes/wp4.md, "T-D1-6", 2026-09-25): 160/1000 kept 19/19 entities, 0 merged turns
 * and p50 final ≈ 0.73 s; the 400 ms points missed p50 ≤ 1 s and 160/2400 merged turns (p90 2.9 s). Re-decided on
 * the real takes (D1 afternoon) with `scripts/day1/stt-grid.ts`.
 */
export const TUNING_8K: TurnTuning = { min_turn_silence: 160, max_turn_silence: 1000 };

/**
 * Scenarios where the REP also speaks Hinglish (the kit's `language_notes`: s19 = customer only, s20 = both).
 * Every other `language: "hinglish"` call gets the Hinglish params on the customer channel only.
 */
export const HINGLISH_REP_SCENARIOS: ReadonlySet<string> = new Set(["s20"]);

/** DESIGN §5.1.5: per CHANNEL, from the scenario's speaker languages. */
export function hinglishChannel(call: Pick<CallManifestEntry, "language" | "scenarioId">, channel: Channel): boolean {
  if (call.language !== "hinglish") return false;
  return channel === "customer" || HINGLISH_REP_SCENARIOS.has(call.scenarioId);
}

/** "en" FIRST keeps English in Latin script and digits as digits (10b ST-12). */
export const HINGLISH_PARAMS = { language_codes: ["en", "hi"], language_detection: true } as const;

const clean = (s: string | null | undefined): string => (s ?? "").replace(/\s+/g, " ").trim();

/**
 * Keyterms from the policy record (DESIGN §5.1.5): policyholder first and last name, existing drivers' names, agency
 * name, carrier, rep first name, every vehicle make and model, street and city, plus STT_FIXED_KEYTERMS.
 * It NEVER uses ground-truth values of the new driver (the policy record does not hold them).
 * Deduplicated case-insensitively, terms > 50 chars dropped, capped at 100 (the server's limits, 10b ST-10).
 */
export function keytermsFromPolicy(policy: PolicyRecord): string[] {
  const raw: string[] = [
    policy.policyholder.firstName,
    policy.policyholder.lastName,
    `${policy.policyholder.firstName} ${policy.policyholder.lastName}`,
    ...policy.existingDrivers.map((d) => d.name),
    policy.agencyName,
    policy.carrier,
    policy.repFirstName,
    ...policy.vehicles.flatMap((v) => [v.make, v.model, `${v.make} ${v.model}`]),
    policy.address.street,
    policy.address.city,
    ...STT_FIXED_KEYTERMS,
  ];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of raw) {
    const k = clean(r);
    if (!k || k.length > LIMITS.keytermChars) continue;
    const key = k.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(k);
    if (out.length >= LIMITS.keyterms) break;
  }
  return out;
}

export interface BuildSttParamsOptions {
  /** Override TUNING_8K (the T-D1-6 grid script; never set in the product). */
  tuning8k?: TurnTuning | null;
  /** Seed `agent_context` at connect (Express start: the last cached rep final, §5.1.6; reconnects, §5.1.9). */
  agentContext?: string;
  /** Force the Hinglish params on/off (the T-D1-6 Hinglish run); default: `hinglishChannel(call, channel)`. */
  hinglish?: boolean;
}

/**
 * The exact Streaming params of one channel of a recorded call (DESIGN §5.1.5). Sanitized: prompt ≤ 1750 chars,
 * keyterms ≤ 100 × ≤ 50 chars, agent_context keeps its last 1750 chars (fatal 3006 otherwise, 10b C15).
 */
export function buildSttParams(
  call: Pick<CallManifestEntry, "format" | "language" | "scenarioId">,
  policy: PolicyRecord,
  channel: Channel,
  opts: BuildSttParamsOptions = {},
): StreamingParams {
  const hinglish = opts.hinglish ?? hinglishChannel(call, channel);
  const tuning = call.format.sampleRate === 8000 ? (opts.tuning8k === undefined ? TUNING_8K : opts.tuning8k) : null;
  const p: StreamingParams = {
    speech_model: STT_SPEECH_MODEL,
    encoding: call.format.encoding,
    sample_rate: call.format.sampleRate,
    mode: STT_MODE,
    inactivity_timeout: STT_INACTIVITY_TIMEOUT_S,
    keyterms_prompt: keytermsFromPolicy(policy),
    prompt: STT_PROMPT,
    ...(hinglish ? { language_codes: [...HINGLISH_PARAMS.language_codes], language_detection: true } : {}),
    ...(tuning ? { min_turn_silence: tuning.min_turn_silence, max_turn_silence: tuning.max_turn_silence } : {}),
    ...(opts.agentContext ? { agent_context: opts.agentContext } : {}),
  };
  return sanitizeParams(p);
}

/** Frame size of the STT feed (DESIGN §5.1.4 / A.2): 100 ms at 8 kHz µ-law (800 B), 50 ms at 16 kHz PCM16 (1600 B). */
export function sttFrameMs(format: CallManifestEntry["format"]): 50 | 100 {
  return format.sampleRate === 8000 ? 100 : 50;
}
/** Bytes per sample of a call's source format (1 for µ-law, 2 for PCM16). */
export function bytesPerSampleOf(format: CallManifestEntry["format"]): 1 | 2 {
  return format.encoding === "pcm_mulaw" ? 1 : 2;
}
/** Source-format silence byte (0xFF µ-law, 0x00 PCM16). */
export function silenceByteOf(format: CallManifestEntry["format"]): number {
  return format.encoding === "pcm_mulaw" ? 0xff : 0x00;
}

// ------------------------------------------------------------------------------------------------ Begin check

export interface BeginCheck {
  ok: boolean;
  /** Human-readable mismatches, e.g. `model: expected universal-3-5-pro, got universal-streaming-english`. */
  mismatches: string[];
}

/**
 * DESIGN §5.1.6 step 3: `Begin.configuration` must echo the model and the mode (typos are silently ignored by the
 * server; only 8 fields are echoed, 10b ST-9). The model may be echoed as `model` (observed) or `speech_model`.
 * A missing `configuration` object counts as a mismatch (the caller decides: dev → E_STT_INPUT, prod → warn).
 */
export function checkBeginConfiguration(
  begin: Pick<BeginMessage, "configuration"> | null | undefined,
  expected: { model?: string; mode?: string } = {},
): BeginCheck {
  const model = expected.model ?? STT_SPEECH_MODEL;
  const mode = expected.mode ?? STT_MODE;
  const cfg = begin?.configuration;
  if (!cfg || typeof cfg !== "object") return { ok: false, mismatches: ["configuration: missing from Begin"] };
  const mismatches: string[] = [];
  const gotModel = (cfg["speech_model"] ?? cfg["model"]) as unknown;
  if (gotModel !== model) mismatches.push(`model: expected ${model}, got ${String(gotModel)}`);
  if (cfg["mode"] !== mode) mismatches.push(`mode: expected ${mode}, got ${String(cfg["mode"])}`);
  return { ok: mismatches.length === 0, mismatches };
}
