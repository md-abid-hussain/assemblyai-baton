import "server-only";

import { buildSttParams } from "../../core/aai/stt-params";
import type { StreamingParamsDto } from "../../core/contracts/api";
import type { Channel, PolicyRecord } from "../../core/contracts/case";
import type { CallManifestEntry } from "../../core/contracts/scenario";

/**
 * Streaming params handed to the browser by route #5 (DESIGN §5.1.5).
 *
 * WP4 owns the real builder, `buildSttParams(call, policy, channel)` in src/core/aai/stt-params.ts (per-channel
 * Hinglish, TUNING_8K after T-D1-6, the URL snapshot test). [WIRE-STT-PARAMS] wired at G1: `sttParamsFor` uses it
 * whenever the call and the policy are known. The golden-defaults fallback below stays only for a request with no
 * manifest entry (the call lookup, [WIRE-CALLS], arrives with WP9's manifest) or no policy.
 */

export const STT_PROMPT =
  "Recorded phone call at a US insurance agency. A customer service representative and a policyholder discuss adding a driver to a personal auto policy: people's names, relationship, age or date of birth, learner's permit or driver's license, vehicle year make and model, ZIP codes, effective dates, and monthly premiums in dollars.";

const FIXED_KEYTERMS = ["learner's permit", "probationary license", "endorsement", "garaging", "premium", "liability limits", "good student discount", "driver's ed"];

/** §5.1.5 `keytermsFromPolicy` (never the new driver's ground truth): ≤100 unique items, ≤50 chars each. */
export function keytermsFromPolicy(policy: PolicyRecord | null): string[] {
  const out: string[] = [];
  if (policy) {
    out.push(policy.policyholder.firstName, policy.policyholder.lastName, policy.agencyName, policy.carrier, policy.repFirstName);
    for (const d of policy.existingDrivers) out.push(d.name);
    for (const v of policy.vehicles) out.push(v.make, v.model);
    out.push(policy.address.street, policy.address.city);
  }
  out.push(...FIXED_KEYTERMS);
  const seen = new Set<string>();
  const res: string[] = [];
  for (const k of out) {
    const s = k.trim().slice(0, 50);
    if (s && !seen.has(s.toLowerCase())) {
      seen.add(s.toLowerCase());
      res.push(s);
    }
  }
  return res.slice(0, 100);
}

export function fallbackSttParams(call: CallManifestEntry | null, policy: PolicyRecord | null, _channel: Channel): StreamingParamsDto {
  const format = call?.format ?? { encoding: "pcm_mulaw" as const, sampleRate: 8000 as const };
  return {
    speech_model: "universal-3-5-pro",
    encoding: format.encoding,
    sample_rate: format.sampleRate,
    mode: "min_latency",
    inactivity_timeout: 30,
    keyterms_prompt: keytermsFromPolicy(policy),
    prompt: STT_PROMPT,
  };
}

export function sttParamsFor(call: CallManifestEntry | null, policy: PolicyRecord | null, channel: Channel): StreamingParamsDto {
  if (!call || !policy) return fallbackSttParams(call, policy, channel);
  // Spread: `StreamingParams` is an interface (no implicit index signature); the DTO is a passthrough object.
  return { ...buildSttParams(call, policy, channel) };
}
