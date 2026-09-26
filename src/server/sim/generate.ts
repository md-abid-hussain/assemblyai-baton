/**
 * server/sim/generate.ts - voice a validated `sim_script` into a `sim_calls` row (PLATFORM §7.5 steps 2-4; WP17·1):
 *
 *   planSimLines (exact handoff line, acceptance next) → TTS every human-half line (rep cedar, customer marin) and
 *   every AI-half clip (confirm / consent / close / answer:<field>) through the cached, ledgered `TtsService` →
 *   assembleSimCall (8 kHz mu-law stereo, peaks, handoff times, ≤ 90 s) → the row `SimCallStore.insert` writes.
 *
 * The script step itself (luna, `sim-script.ts`) is WP17·2; the route and job (`/api/sim-calls`) are WP17·3.
 *
 * Ids: `sim_<first 16 hex of sha256(key)>`. The key is fixed before the script exists (POST returns the id at once),
 * so it carries a `salt`: the gallery build uses a fixed salt (deterministic ids); on-demand sims use a fresh one so a
 * regenerated sim never reuses an id whose assets a browser cached as immutable.
 */
import "server-only";

import { createHash } from "node:crypto";

import type { SimAiClips, SimCallInsert, SimRelayRef, TtsClip } from "../../core/contracts/ext/wp17-sim";
import { simCallIdOf } from "../../core/contracts/ext/wp17-sim";
import type { Blueprint } from "../../core/contracts/v2/blueprint";
import type { SimCallKind, SimScript } from "../../core/contracts/v2/api";
import type { TtsService } from "../openai/tts";
import { assembleSimCall, planSimLines, type AssembledSimCall } from "./assemble";
import { planAiClips, voiceFor } from "./voices";

export const SIM_PIPELINE_VERSION = "sim/1" as const;

/** `sim_<16 hex>` for a (kind, relay version or gallery key, sample, salt). */
export function simCallIdFor(i: { kind: SimCallKind; versionKey: string; sampleIndex: number; salt: string }): string {
  const key = [SIM_PIPELINE_VERSION, i.kind, i.versionKey, String(i.sampleIndex), i.salt].join("|");
  return simCallIdOf(createHash("sha256").update(key, "utf8").digest("hex"));
}

export interface VoiceSimInput {
  simCallId: string;
  script: SimScript;
  blueprint: Pick<Blueprint, "handoff" | "playbook" | "context">;
  sampleIndex: number;
  relay: SimRelayRef;
  relayVersionId: string;
  gallery: boolean;
  /** The luna script's cost, added to the row's `usd`. */
  scriptUsd?: number;
  concurrency?: number;
}

export interface VoicedSim {
  row: SimCallInsert & { kind: "audio" };
  assembled: AssembledSimCall;
  /** Every clip used, by hash (for static export in the gallery build). */
  clips: Map<string, TtsClip>;
  ttsUsd: number;
  cachedClips: number;
  totalClips: number;
  /** Characters sent to TTS for the human half (the §7.5 ≤ 1200-char budget). */
  humanChars: number;
}

export async function voiceSimCall(tts: TtsService, i: VoiceSimInput): Promise<VoicedSim> {
  const sample = i.blueprint.context.samples[i.sampleIndex];
  if (!sample) throw new RangeError(`sample ${i.sampleIndex} does not exist`);
  const tone = i.blueprint.playbook.persona.tone;
  const { script, lines } = planSimLines(i.script, { repLine: i.blueprint.handoff.repLine });
  const aiPlan = planAiClips(script);

  const requests = [
    ...lines.map((l) => ({ text: l.text, ...voiceFor(l.speaker, tone, sample), refId: i.simCallId })),
    ...aiPlan.map((c) => ({ text: c.text, ...voiceFor("customer", tone, sample), refId: i.simCallId })),
  ];
  const voiced = await tts.synthMany(requests, i.concurrency ?? 3);
  const lineClips = voiced.slice(0, lines.length);
  const aiClipsVoiced = voiced.slice(lines.length);

  const assembled = assembleSimCall(
    lines.map((l, k) => ({ speaker: l.speaker, tag: l.tag, text: l.text, pcm24k: lineClips[k]!.pcm24k, clipHash: lineClips[k]!.hash })),
    { seed: i.simCallId },
  );
  const aiClips: SimAiClips = Object.fromEntries(
    aiPlan.map((c, k) => [c.key, { hash: aiClipsVoiced[k]!.hash, text: c.text, durationMs: aiClipsVoiced[k]!.durationMs }]),
  );
  const clips = new Map<string, TtsClip>();
  for (const c of voiced) if (!clips.has(c.hash)) clips.set(c.hash, c);
  const ttsUsd = Math.round(voiced.reduce((s, c) => s + c.usd, 0) * 1e6) / 1e6;

  return {
    row: {
      id: i.simCallId,
      kind: "audio",
      relayVersionId: i.relayVersionId,
      sampleIndex: i.sampleIndex,
      script: { ...script, timeline: assembled.timeline, relay: i.relay, dryRun: null },
      rep: assembled.rep,
      customer: assembled.customer,
      peaks: assembled.peaks,
      durationMs: assembled.durationMs,
      handoff: assembled.handoff,
      aiClips,
      usd: Math.round(((i.scriptUsd ?? 0) + ttsUsd) * 1e6) / 1e6,
      gallery: i.gallery,
    },
    assembled,
    clips,
    ttsUsd,
    cachedClips: voiced.filter((c) => c.cached).length,
    totalClips: voiced.length,
    humanChars: lines.reduce((s, l) => s + l.text.length, 0),
  };
}
