/**
 * server/sim/voices.ts - who speaks a simulated call, and how (PLATFORM §7.5 step 2).
 *
 * - Rep = `cedar`; the TTS `instructions` come from the relay's `persona.tone` and the sample's org and rep name.
 * - Customer = `marin` with ONE fixed instruction for every relay and sample, so a customer line that recurs
 *   ("Yes, that's right.") hashes to the same `tts_cache` row everywhere: the shared clips are generated once,
 *   globally. (The customer is a fictional stranger; nothing in the sample needs to colour their voice.)
 */
import "server-only";

import { SHARED_CUSTOMER_CLIPS, SIM_VOICES, type SimAiClipKey, type SimSpeaker } from "../../core/contracts/ext/wp17-sim";
import type { AccountRecord } from "../../core/contracts/v2/blueprint";
import type { SimScript } from "../../core/contracts/v2/api";

export const CUSTOMER_INSTRUCTIONS =
  "A relaxed customer on a phone call with a service rep. Natural, conversational and clear; moderate pace; say numbers plainly.";

const oneLine = (s: string, max: number): string => s.replace(/\s+/g, " ").trim().slice(0, max);

export function repInstructions(tone: string, sample: Pick<AccountRecord, "org">): string {
  const who = `${oneLine(sample.org.repFirstName, 40)}, a phone representative at ${oneLine(sample.org.name, 80)}`;
  const t = oneLine(tone, 200) || "Warm, calm and professional.";
  return `Voice: ${who}. Tone: ${t} Natural phone-call pacing; read numbers and names clearly.`;
}

export function voiceFor(speaker: SimSpeaker, tone: string, sample: Pick<AccountRecord, "org">): { voice: string; instructions: string } {
  return speaker === "rep"
    ? { voice: SIM_VOICES.rep, instructions: repInstructions(tone, sample) }
    : { voice: SIM_VOICES.customer, instructions: CUSTOMER_INSTRUCTIONS };
}

/**
 * The AI-half clips the autopilot customer plays by suggestion kind (PLATFORM §7.5 step 5): `confirm` (shared),
 * `consent` and `close` from the script, and one `answer:<field>` per `ai_half_answers` entry. All customer voice.
 */
export function planAiClips(script: Pick<SimScript, "consent_phrase" | "closing_phrase" | "ai_half_answers">): { key: SimAiClipKey; text: string }[] {
  const out: { key: SimAiClipKey; text: string }[] = [
    { key: "confirm", text: SHARED_CUSTOMER_CLIPS.confirm },
    { key: "consent", text: oneLine(script.consent_phrase, 300) || SHARED_CUSTOMER_CLIPS.consentGoAhead },
    { key: "close", text: oneLine(script.closing_phrase, 300) || SHARED_CUSTOMER_CLIPS.close },
  ];
  const seen = new Set<string>();
  for (const a of script.ai_half_answers) {
    const text = oneLine(a.spoken, 300);
    if (!text || seen.has(a.field)) continue;
    seen.add(a.field);
    out.push({ key: `answer:${a.field}`, text });
  }
  return out;
}
