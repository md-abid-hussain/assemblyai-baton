/**
 * gen-fixtures.ts - generate audio fixtures with OpenAI TTS (cached; re-runs are free).
 *
 *   npx tsx scripts/gen-fixtures.ts            # all
 *   npx tsx scripts/gen-fixtures.ts question   # one of: question | dialog | codeswitch
 *
 * Outputs (spikes/fixtures/):
 *   question_24k.wav, question_16k.wav, question_8k.mulaw (raw G.711 mu-law, no header)
 *   dialog_mono_16k.wav, dialog_stereo_16k.wav (L = adjuster, R = claimant), dialog_script.json
 *   codeswitch_16k.wav, codeswitch_script.json
 * Log: spikes/out/gen-fixtures.jsonl
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { FIXTURES_DIR } from "../lib/env.ts";
import { createLogger } from "../lib/log.ts";
import { DEFAULT_TTS_MODEL, TTS_SAMPLE_RATE, ttsPcm24k } from "../lib/tts.ts";
import { writeWav } from "../lib/wav.ts";
import { concatPcm16, framesToMs, interleave, mulawEncode, resampleLinear, silencePcm16, trimSilence } from "../lib/audio.ts";

const only = process.argv[2];
const log = createLogger("gen-fixtures");
mkdirSync(FIXTURES_DIR, { recursive: true });
const fx = (name: string) => resolve(FIXTURES_DIR, name);
const summary: Record<string, unknown>[] = [];

// ---------------------------------------------------------------------------------------------
// a. question
// ---------------------------------------------------------------------------------------------
async function genQuestion() {
  const text = "Hi, I'm calling about my order. The order number is 4 8 1 5 2 9, and it still hasn't arrived.";
  const r = await ttsPcm24k(
    {
      input: text,
      voice: "marin",
      instructions:
        "A customer calling a support line. Natural, slightly frustrated but polite, normal conversational pace. Read the order number digit by digit with a short pause between digits.",
    },
    log,
  );
  const pcm24 = r.samples;
  const pcm16 = resampleLinear(pcm24, TTS_SAMPLE_RATE, 16000);
  const pcm8 = resampleLinear(pcm24, TTS_SAMPLE_RATE, 8000);
  writeWav(fx("question_24k.wav"), pcm24, 24000);
  writeWav(fx("question_16k.wav"), pcm16, 16000);
  writeFileSync(fx("question_8k.mulaw"), mulawEncode(pcm8));
  const s = { fixture: "question", text, voice: "marin", model: DEFAULT_TTS_MODEL, durationMs: Math.round(r.durationMs), ttsMs: r.ms, cached: r.cached };
  log.note("fixture written", s);
  summary.push(s);
}

// ---------------------------------------------------------------------------------------------
// b. dialog (insurance claim call)
// ---------------------------------------------------------------------------------------------
type Speaker = "adjuster" | "claimant";
const VOICES: Record<Speaker, { voice: string; name: string; channel: "left" | "right"; instructions: string }> = {
  adjuster: {
    voice: "cedar",
    name: "Daniel Reyes",
    channel: "left",
    instructions: "Calm, professional insurance claims adjuster on a phone call. Warm but efficient, steady conversational pace.",
  },
  claimant: {
    voice: "marin",
    name: "Priya Shah",
    channel: "right",
    instructions:
      "A driver calling her insurer after a minor car accident. Slightly stressed but cooperative, natural conversational pace. Read letters and digits of reference numbers one at a time.",
  },
};

const DIALOG: { speaker: Speaker; text: string }[] = [
  { speaker: "adjuster", text: "Harbor Point claims, Daniel Reyes speaking. Your name and policy number, please?" },
  { speaker: "claimant", text: "Hi, it's Priya Shah. Policy number H P 7 7 4 0 3 9 1." },
  { speaker: "adjuster", text: "Thanks, Ms. Shah. What happened?" },
  { speaker: "claimant", text: "I was rear-ended on Tuesday, September 15th, around 5 p.m., outside 1420 Maple Avenue in Springfield." },
  { speaker: "adjuster", text: "Was anyone hurt?" },
  { speaker: "claimant", text: "No, just a sore neck. The other driver, Mark Donnelly, was on his phone." },
  { speaker: "adjuster", text: "Do you have a repair estimate?" },
  { speaker: "claimant", text: "Lakeside Auto Body quoted $3,450, and the tow was $125." },
  { speaker: "adjuster", text: "Okay, your deductible is $500. What time did the accident happen?" },
  { speaker: "claimant", text: "It was around 7 p.m. It was already getting dark." },
  { speaker: "adjuster", text: "Got it. What's the best number to reach you?" },
  { speaker: "claimant", text: "My cell is 415-555-0137." },
  { speaker: "adjuster", text: "And you are still at 88 Birchwood Lane, Springfield?" },
  { speaker: "claimant", text: "Yes, that's right." },
  { speaker: "adjuster", text: "Great. Your claim number is C L 4 4 8 1 2. An appraiser will call you Friday at 10 a.m." },
  { speaker: "claimant", text: "Perfect, thanks, Daniel." },
];

const GAP_MS = 250;
const OUT_RATE = 16000;

async function genDialog() {
  const turns: { index: number; speaker: Speaker; name: string; voice: string; channel: string; text: string; start_ms: number; end_ms: number; tts_raw_ms: number }[] = [];
  const left: Int16Array[] = [];
  const right: Int16Array[] = [];
  const mono: Int16Array[] = [];
  let pos = 0; // frames at 16 kHz
  let ttsMs = 0;
  let cachedAll = true;
  for (const [i, t] of DIALOG.entries()) {
    const v = VOICES[t.speaker];
    const r = await ttsPcm24k({ input: t.text, voice: v.voice, instructions: v.instructions }, log);
    ttsMs += r.ms;
    cachedAll &&= r.cached;
    // Tight speech boundaries so the 250 ms gap is real silence and start/end are meaningful.
    const trimmed = trimSilence(r.samples, TTS_SAMPLE_RATE, { thresholdDb: -50, padMs: 20 }).samples;
    const clip = resampleLinear(trimmed, TTS_SAMPLE_RATE, OUT_RATE);
    if (i > 0) {
      const gap = silencePcm16(GAP_MS, OUT_RATE);
      mono.push(gap);
      left.push(gap);
      right.push(gap);
      pos += gap.length;
    }
    const zeros = new Int16Array(clip.length);
    mono.push(clip);
    left.push(t.speaker === "adjuster" ? clip : zeros);
    right.push(t.speaker === "claimant" ? clip : zeros);
    const start = Math.round(framesToMs(pos, OUT_RATE));
    pos += clip.length;
    const end = Math.round(framesToMs(pos, OUT_RATE));
    turns.push({ index: i, speaker: t.speaker, name: v.name, voice: v.voice, channel: v.channel, text: t.text, start_ms: start, end_ms: end, tts_raw_ms: Math.round(r.durationMs) });
  }
  const monoPcm = concatPcm16(mono);
  const stereoPcm = interleave(concatPcm16(left), concatPcm16(right));
  writeWav(fx("dialog_mono_16k.wav"), monoPcm, OUT_RATE, 1);
  writeWav(fx("dialog_stereo_16k.wav"), stereoPcm, OUT_RATE, 2);
  const durationMs = Math.round(framesToMs(monoPcm.length, OUT_RATE));
  const script = {
    description: "Insurance claim phone call: adjuster (left channel) and claimant (right channel). Turns sequential with 250 ms silence gaps.",
    generated_at: new Date().toISOString(),
    tts: { model: DEFAULT_TTS_MODEL, response_format: "pcm (24 kHz s16le mono)", resampled_to: OUT_RATE, trim: "leading/trailing < -50 dBFS trimmed, 20 ms pad" },
    files: {
      mono: "dialog_mono_16k.wav",
      stereo: "dialog_stereo_16k.wav",
      stereo_channels: { left: "adjuster", right: "claimant" },
    },
    sample_rate: OUT_RATE,
    gap_ms: GAP_MS,
    duration_ms: durationMs,
    speakers: {
      adjuster: { name: VOICES.adjuster.name, voice: VOICES.adjuster.voice, channel: "left", role: "insurance claims adjuster" },
      claimant: { name: VOICES.claimant.name, voice: VOICES.claimant.voice, channel: "right", role: "claimant / driver" },
    },
    turns,
    // Ground truth for entity / contradiction tests.
    facts: {
      insurer: "Harbor Point",
      people: ["Daniel Reyes", "Priya Shah", "Mark Donnelly"],
      organizations: ["Harbor Point", "Lakeside Auto Body"],
      policy_number: "HP7740391",
      claim_number: "CL44812",
      accident_date: "Tuesday, September 15th (2026-09-15)",
      accident_location: "1420 Maple Avenue, Springfield",
      mailing_address: "88 Birchwood Lane, Springfield",
      phone_number: "415-555-0137",
      amounts_usd: { repair_estimate: 3450, tow: 125, deductible: 500 },
      appraiser_callback: "Friday at 10 a.m.",
      contradiction: {
        topic: "time of accident",
        first: { turn_index: 3, value: "around 5 p.m." },
        second: { turn_index: 9, value: "around 7 p.m." },
        flagged_in_dialog: false,
      },
    },
  };
  writeFileSync(fx("dialog_script.json"), JSON.stringify(script, null, 2));
  const s = { fixture: "dialog", turns: turns.length, durationMs, ttsMs, cachedAll };
  log.note("fixture written", s);
  summary.push(s);
}

// ---------------------------------------------------------------------------------------------
// c. Hinglish code-switch
// ---------------------------------------------------------------------------------------------
async function genCodeswitch() {
  // Romanized transcript (ground truth as a Hinglish speaker would type it).
  const romanized =
    "Mera order abhi tak nahi aaya, can you please check the status? Order number hai 4 8 1 5 2 9. Aur haan, delivery kal tak ho jayegi kya?";
  // TTS input: Hindi words in Devanagari so the model pronounces them as Hindi, English words kept in Latin script.
  // v2 (2026-09-24): digits are spelled as English words. v1 used "4 8 1 5 2 9" inside the Devanagari
  // sentence; the TTS then mixed Hindi digits in and the third digit came out as an ambiguous
  // "ek"/"eight" (gpt-4o-transcribe, gpt-audio-1.5 and gpt-audio-mini all heard 488529), so the
  // fixture's ground truth was not recoverable. See out/probe-codeswitch_16k-v1.jsonl (v1 audio: .cache/codeswitch_16k.v1.wav).
  const ttsInput =
    "मेरा order अभी तक नहीं आया, can you please check the status? Order number है four, eight, one, five, two, nine. और हाँ, delivery कल तक हो जाएगी क्या?";
  const spokenDigits = "four eight one five two nine (English)";
  const voice = "coral";
  const instructions =
    "A native Hindi-English bilingual speaker from Delhi, India, talking to a customer support agent. Natural Indian accent, code-switching fluidly between Hindi and English as in everyday Hinglish. Say the order number digits in English, clearly and one at a time: four, eight, one, five, two, nine.";
  const r = await ttsPcm24k({ input: ttsInput, voice, instructions }, log);
  const trimmed = trimSilence(r.samples, TTS_SAMPLE_RATE, { thresholdDb: -50, padMs: 60 }).samples;
  const pcm16 = resampleLinear(trimmed, TTS_SAMPLE_RATE, 16000);
  writeWav(fx("codeswitch_16k.wav"), pcm16, 16000);
  const durationMs = Math.round(framesToMs(pcm16.length, 16000));
  writeFileSync(
    fx("codeswitch_script.json"),
    JSON.stringify(
      {
        description: "Hinglish (Hindi-English) code-switched customer utterance.",
        file: "codeswitch_16k.wav",
        sample_rate: 16000,
        duration_ms: durationMs,
        transcript_romanized: romanized,
        spoken_digits: spokenDigits,
        tts_input: ttsInput,
        tts: { model: DEFAULT_TTS_MODEL, voice, instructions },
        languages: ["hi", "en"],
        facts: { order_number: "481529" },
      },
      null,
      2,
    ),
  );
  const s = { fixture: "codeswitch", voice, durationMs, ttsMs: r.ms, cached: r.cached };
  log.note("fixture written", s);
  summary.push(s);
}

try {
  if (!only || only === "question") await genQuestion();
  if (!only || only === "dialog") await genDialog();
  if (!only || only === "codeswitch") await genCodeswitch();
  log.result("PASS", { summary });
  console.table(summary);
} catch (e) {
  log.error(e);
  log.result("FAIL", { summary });
  console.error("gen-fixtures failed:", e instanceof Error ? e.message : e);
  process.exitCode = 1;
} finally {
  log.close();
}
