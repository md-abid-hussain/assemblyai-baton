/**
 * src/content/field-notes.ts - "Field notes: what we verified live on AssemblyAI's APIs" (P§12.5), for the landing
 * page and the README. Every item is dated and points at a public file in this repo (`research/10*.md`,
 * `docs/notes/*.md`). Numbers quoted in a finding are `PitchNumber`s (see `numbers.ts`); a unit test checks that each
 * quoted value appears verbatim in its finding.
 */
import type { FieldNote } from "@/core/contracts/ext/wp13-content";

export const FIELD_NOTES_TITLE = "Field notes: what we verified live on AssemblyAI's APIs";

export const FIELD_NOTES_INTRO =
  "Dated findings from our own live tests, run before and during the build from a client in India (about 170 ms " +
  "from the US endpoints). The logs and exact requests are in research/10*.md and docs/notes/ in the repo.";

export const FIELD_NOTES: readonly FieldNote[] = [
  {
    date: "2026-09-24",
    finding: [
      "A ",
      { code: "reply.create" },
      " sent while a tool is on ",
      { code: "hold" },
      " is silent: 0 audio chunks in 2 of 2 runs. The text shows up only in ",
      { code: "transcript.agent" },
      ".",
    ],
    consequence: "The payment step uses push mode: the tool returns at once and we push the next step when the payment lands.",
    ref: "T-D1-1, docs/notes/wp5b.md",
    numberIds: ["N-hold-silent"],
  },
  {
    date: "2026-09-24",
    finding: [
      "HTTP tools inside ",
      { code: "session.update" },
      " are rejected with ",
      { code: "invalid_value" },
      " in all three shapes we tried. HTTP tools work on stored agents (",
      { code: "POST /v1/agents" },
      ").",
    ],
    consequence: "Test runs use function tools executed by our server; Publish creates a stored agent with HTTP tools.",
    ref: "T-D1-5, docs/notes/wp5b.md",
  },
  {
    date: "2026-09-25",
    finding: [
      { code: "DELETE /v1/sessions/{id}" },
      " on a live session answers 204 but does not end it: the agent keeps talking and billing. On an ended session the recording URLs return 404 at once.",
    ],
    consequence: "We end sessions with session.end, and use DELETE only to remove recordings after a call has ended.",
    ref: "T-D1-0b, docs/notes/wp8.md",
    numberIds: ["N-delete-ended"],
  },
  {
    date: "2026-09-24",
    finding: [
      "A ",
      { code: "session.update" },
      " with the next stage's prompt and tools, followed at once by the ",
      { code: "tool.result" },
      ", works without waiting for ",
      { code: "session.updated" },
      ": the reply it triggers calls the new stage's tool 650–880 ms later.",
    ],
    consequence: "Stage changes (confirm → disclose → pay → close) are one update plus one result, no extra round trip.",
    ref: "T-D1-2, docs/notes/wp5b.md",
    numberIds: ["N-stage-change"],
  },
  {
    date: "2026-09-24",
    finding: [
      "Sending ",
      { code: "tool.result" },
      " as soon as the tool finishes, instead of after ",
      { code: "reply.done" },
      ", is accepted and about 1.0 s faster to the audible answer.",
    ],
    consequence: "Tool results go out immediately; results for interrupted replies are dropped.",
    ref: "VA-8, research/10-smoke-test-results.md",
    numberIds: ["N-early-tool-result"],
  },
  {
    date: "2026-09-24",
    finding: [
      { code: "transcription_mode" },
      " and keyterms can be changed mid-session; a partial ",
      { code: "input" },
      " update merges with the earlier one. Keyterms in the first update are accepted and echoed.",
    ],
    consequence:
      "The AI half picks the turn mode for each question: min_latency for yes/no answers, balanced when it asks for a missing name, date or ZIP code.",
    ref: "T-D1-0 and T-D1-4, docs/notes/wp5b.md",
  },
  {
    date: "2026-09-24",
    finding: [
      "A stored ",
      { code: "agent_id" },
      " must be alone in the first ",
      { code: "session.update" },
      "; adding any other field closes the socket (1008).",
    ],
    consequence: "Published relays start with the agent id alone, then send the case in a second update.",
    ref: "Voice Agent smoke test T9, research/10a-voice-agent-smoke.md",
  },
  {
    date: "2026-09-24",
    finding: [
      "Streaming diarization on one mixed session cut finals on a ~10 s grid and mixed both speakers in 7 of 8 finals. One Universal-3.5 Pro Realtime session per channel put 27/27 finals on the right speaker.",
    ],
    consequence: "Every call is shadowed with one Realtime session per channel (rep and customer).",
    ref: "ST-5 and ST-6, research/10-smoke-test-results.md",
    numberIds: ["N-diarization-mixed", "N-per-channel"],
  },
  {
    date: "2026-09-24",
    finding: [
      "Recorded phone calls are 8 kHz. On a proxy grid (TTS dialog → 8 kHz µ-law), ",
      { code: "min_turn_silence" },
      " 160 ms with ",
      { code: "max_turn_silence" },
      " 1000 ms kept all 19 entities, merged no turns, and finalized at a p50 of about 0.73 s.",
    ],
    consequence: "Telephony runs use 160 / 1000 (provisional until the grid is re-run on the recorded takes).",
    ref: "T-D1-6, docs/notes/wp4.md",
    numberIds: ["N-turn-8k"],
  },
  {
    date: "2026-09-24",
    finding: [
      "A Voice Agent socket left idle for 12 s before its first update stayed open and was not billed for the idle time; the recording was ready for async transcription about 7 s after the session ended, and the multichannel transcript took 3.4–4.2 s.",
    ],
    consequence: "We open the socket while the rep is still talking, and verify each AI half from its recording right after the call.",
    ref: "T-D1-3 and VA-13, docs/notes/wp5b.md, research/10-smoke-test-results.md",
    numberIds: ["N-idle-not-billed", "N-async-verify"],
  },
];

/** Three lines on what we changed after measuring (P§12.5). */
export const ITERATION_LOG: readonly string[] = [
  "Greeting: 65–69 words (22–24 s before the customer could answer) → at most 40 words.",
  "Payment step: tool hold (silent status lines) → push mode.",
  "8 kHz turn detection: default silences → min_turn_silence 160 ms, max_turn_silence 1000 ms (provisional).",
];
