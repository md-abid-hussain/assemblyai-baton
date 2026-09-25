/**
 * src/content/numbers.ts - every number the public copy in `src/content/**` shows, with its provenance tag.
 *
 * Source of truth for the pitch is `docs/pitch/numbers.md`; this file is the typed subset the app renders. A unit test
 * (`tests/unit/content/numbers.test.ts`) checks that each entry here has a row with the same id, tag and value there.
 *
 * Rules (TASKS-v2 WP13, P§1.4, P§11):
 * - headline product metrics come from recorded takes only and are stated as "n runs over k distinct recorded takes";
 *   until measured their value is null and nothing renders;
 * - API measurements say how many sessions and from where (a client in India, about 170 ms from the US endpoints);
 * - no freed-rep-minutes number appears here (it stays locked in numbers.md until s01's handoff line is confirmed).
 */
import type { PitchNumber } from "@/core/contracts/ext/wp13-content";

const WP5B = "docs/notes/wp5b.md";
const SMOKE = "research/10-smoke-test-results.md";
const VA_SMOKE = "research/10a-voice-agent-smoke.md";

export const PITCH_NUMBERS = [
  // ------------------------------------------------------------------ headline metrics (recorded takes only; pending)
  {
    id: "N-facts-at-pass",
    label: "Facts correct at the pass",
    value: null,
    tag: "measured",
    provenance: "n runs over k distinct recorded takes (G2–G5 live specs and the video takes)",
    asOf: "2026-09-25",
  },
  {
    id: "N-reasked",
    label: "Questions re-asked by the AI",
    value: null,
    tag: "measured",
    provenance: "n runs over k distinct recorded takes, counted from the AI half's recording",
    asOf: "2026-09-25",
  },
  {
    id: "N-verbatim",
    label: "Disclosure read verbatim (similarity)",
    value: null,
    tag: "measured",
    provenance: "n runs over k distinct recorded takes, async transcript vs the disclosure text",
    asOf: "2026-09-25",
  },
  {
    id: "N-dead-air-p50",
    label: "Dead air in the AI half (p50)",
    value: null,
    tag: "measured",
    provenance: "n runs over k distinct recorded takes, from the HUD timings",
    asOf: "2026-09-25",
  },

  // ------------------------------------------------------------------ measured on AssemblyAI's APIs while building
  {
    id: "N-smoke-tests",
    label: "Live API smoke tests before product code",
    value: "61",
    tag: "measured",
    provenance: "45 pass, 10 partial, 5 fail, 1 skipped; Voice Agent, Realtime STT, async and OpenAI",
    source: SMOKE,
    asOf: "2026-09-24",
  },
  {
    id: "N-va-ready",
    label: "First session.update to session.ready",
    value: "611–672 ms",
    tag: "measured",
    provenance: "5 Voice Agent sessions, client in India (about 170 ms round trip to the US endpoints)",
    source: WP5B,
    asOf: "2026-09-24",
  },
  {
    id: "N-greeting-v1",
    label: "Our first greeting",
    value: "65–69 words",
    tag: "measured",
    provenance: "4 sessions (T-D1-0): 22.0–23.7 s of audio before the customer could answer",
    source: WP5B,
    asOf: "2026-09-24",
  },
  {
    id: "N-stage-change",
    label: "Stage change to the new stage's tool call",
    value: "650–880 ms",
    tag: "measured",
    provenance: "2 runs (T-D1-2): session.update then tool.result on the same socket",
    source: WP5B,
    asOf: "2026-09-24",
  },
  {
    id: "N-early-tool-result",
    label: "Sending tool.result before reply.done",
    value: "about 1.0 s faster",
    tag: "measured",
    provenance:
      "VA-8, reply.create-triggered turns without endpointing: the saving is the difference, not an end-to-end latency",
    source: SMOKE,
    asOf: "2026-09-24",
  },
  {
    id: "N-hold-silent",
    label: "reply.create during a tool hold",
    value: "0 audio chunks",
    tag: "measured",
    provenance: "T-D1-1, 2 of 2 runs: the text arrived in transcript.agent, no audio",
    source: WP5B,
    asOf: "2026-09-24",
  },
  {
    id: "N-va-turn",
    label: "End of speech to audible reply (plain turns, min_latency)",
    value: "2.1–2.6 s",
    tag: "measured",
    provenance: "Voice Agent smoke test 4; balanced 2.9–3.2 s; client in India",
    source: VA_SMOKE,
    asOf: "2026-09-24",
  },
  {
    id: "N-per-channel",
    label: "One Realtime STT session per channel",
    value: "27/27 finals",
    tag: "measured",
    provenance: "ST-6, one two-speaker stereo test clip: 27/27 finals on the right speaker, 21/21 entities, 4.3% WER",
    source: SMOKE,
    asOf: "2026-09-24",
  },
  {
    id: "N-diarization-mixed",
    label: "Single-session diarization, same clip",
    value: "7 of 8 finals",
    tag: "measured",
    provenance: "ST-5: 7 of 8 finals mixed both speakers; finals were cut on a ~10 s grid",
    source: SMOKE,
    asOf: "2026-09-24",
  },
  {
    id: "N-idle-not-billed",
    label: "Idle socket before the first update",
    value: "12 s",
    tag: "measured",
    provenance: "T-D1-3 part A: not closed, and 2.26 s billed for a 14.7 s socket",
    source: WP5B,
    asOf: "2026-09-24",
  },
  {
    id: "N-async-verify",
    label: "AI-half recording to async multichannel transcript",
    value: "3.4–4.2 s",
    tag: "measured",
    provenance: "VA-13: artifacts about 7 s after the session ends; pre-signed URLs last 1 h",
    source: SMOKE,
    asOf: "2026-09-24",
  },
  {
    id: "N-turn-8k",
    label: "8 kHz turn tuning (min_turn_silence)",
    value: "160 ms",
    tag: "measured",
    provenance: "T-D1-6 proxy grid (TTS dialog → 8 kHz µ-law): 19/19 entities, 0 merged turns; provisional until the real-take grid",
    source: "docs/notes/wp4.md",
    asOf: "2026-09-24",
  },
  {
    id: "N-delete-ended",
    label: "DELETE on an ended Voice Agent session",
    value: "404 at once",
    tag: "measured",
    provenance: "T-D1-0b, 2 sessions: the recording URLs 404 at once; on a live session DELETE answers 204 and the call keeps running",
    source: "docs/notes/wp8.md",
    asOf: "2026-09-25",
  },

  // ------------------------------------------------------------------ public sources
  {
    id: "N-repeat-55",
    label: "End users who say having to repeat themselves is what they hate most",
    value: "55%",
    tag: "sourced",
    provenance: "AssemblyAI 2026 Voice Agent Insights Report",
    source: "https://www.assemblyai.com/voice-agent-report",
    asOf: "2026-09-24",
  },
  {
    id: "N-scan",
    label: "Vendors whose public docs we checked for the handoff direction",
    value: "22",
    tag: "sourced",
    provenance: "19 voice-agent and contact-center vendors plus 3 PCI payment-handoff vendors (list in docs/pitch/numbers.md §5)",
    source: "docs/pitch/numbers.md",
    asOf: "2026-09-24",
  },
] as const satisfies readonly PitchNumber[];

export type PitchNumberId = (typeof PITCH_NUMBERS)[number]["id"];

const BY_ID: ReadonlyMap<string, PitchNumber> = new Map(PITCH_NUMBERS.map((n) => [n.id, n as PitchNumber]));

/** The number with this id. Throws on an unknown id (a content bug, caught by the unit tests). */
export function pitchNumber(id: string): PitchNumber {
  const n = BY_ID.get(id);
  if (!n) throw new Error(`unknown pitch number id: ${id}`);
  return n;
}

/** Only the numbers that may be rendered: measured ones without a value are dropped. */
export function renderableNumbers(ids: readonly string[]): PitchNumber[] {
  return ids.map(pitchNumber).filter((n) => n.value !== null);
}
