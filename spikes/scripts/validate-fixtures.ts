/**
 * validate-fixtures.ts - check every fixture's format, duration, levels and (for the dialog) channel
 * isolation + script timing. Optional `--transcribe` sends question (16k + decoded mu-law), codeswitch
 * and dialog-mono (~97 s of audio) to OpenAI gpt-4o-transcribe (~$0.01 total) and checks that the
 * expected entities appear, i.e. that the TTS actually said the right words.
 *
 *   npx tsx scripts/validate-fixtures.ts [--transcribe]
 *
 * Writes spikes/out/validate-fixtures[-content].jsonl and spikes/out/fixtures-validation[-content].json
 * (the -content names are used with --transcribe, so an offline run never overwrites content evidence).
 */
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { FIXTURES_DIR, OUT_DIR } from "../lib/env.ts";
import { createLogger } from "../lib/log.ts";
import { encodeWav, readWav, type WavData } from "../lib/wav.ts";
import { deinterleave, msToFrames, mulawDecode, peakDbfs, rmsDbfs } from "../lib/audio.ts";

const CONTENT_MODE = process.argv.includes("--transcribe");
const SUFFIX = CONTENT_MODE ? "-content" : "";
const log = createLogger(`validate-fixtures${SUFFIX}`);
const fx = (n: string) => resolve(FIXTURES_DIR, n);
type Row = { file: string; format: string; sampleRate: number; channels: number; durationMs: number; bytes: number; rmsDb: string; peakDb: string; clipped: number; ok: boolean; notes: string };
const rows: Row[] = [];
const problems: string[] = [];

const clippedCount = (x: Int16Array) => x.reduce((a, v) => a + (v >= 32767 || v <= -32768 ? 1 : 0), 0);
const db = (v: number) => (v === -Infinity ? "-inf" : v.toFixed(1));

function checkWav(file: string, rate: number, channels: number, minMs: number, maxMs: number): WavData | undefined {
  const p = fx(file);
  if (!existsSync(p)) {
    problems.push(`${file}: missing`);
    rows.push({ file, format: "-", sampleRate: 0, channels: 0, durationMs: 0, bytes: 0, rmsDb: "-", peakDb: "-", clipped: 0, ok: false, notes: "missing" });
    return undefined;
  }
  const w = readWav(p);
  const notes: string[] = [];
  if (w.sampleRate !== rate) notes.push(`rate ${w.sampleRate} != ${rate}`);
  if (w.channels !== channels) notes.push(`channels ${w.channels} != ${channels}`);
  if (w.formatTag !== 1) notes.push(`format tag ${w.formatTag}`);
  if (w.durationMs < minMs || w.durationMs > maxMs) notes.push(`duration ${w.durationMs.toFixed(0)} not in [${minMs}, ${maxMs}]`);
  const rms = rmsDbfs(w.samples);
  const peak = peakDbfs(w.samples);
  const clipped = clippedCount(w.samples);
  if (rms < -45) notes.push("nearly silent");
  if (clipped > 10) notes.push(`${clipped} clipped samples`);
  const ok = notes.length === 0;
  if (!ok) problems.push(`${file}: ${notes.join("; ")}`);
  rows.push({ file, format: "WAV PCM16", sampleRate: w.sampleRate, channels: w.channels, durationMs: Math.round(w.durationMs), bytes: statSync(p).size, rmsDb: db(rms), peakDb: db(peak), clipped, ok, notes: notes.join("; ") });
  return w;
}

// question -------------------------------------------------------------------------------------
const q24 = checkWav("question_24k.wav", 24000, 1, 4000, 12000);
const q16 = checkWav("question_16k.wav", 16000, 1, 4000, 12000);
{
  const file = "question_8k.mulaw";
  const p = fx(file);
  if (existsSync(p)) {
    const bytes = readFileSync(p);
    const pcm = mulawDecode(bytes);
    const dur = (bytes.length / 8000) * 1000;
    const notes: string[] = [];
    if (q24 && Math.abs(dur - q24.durationMs) > 5) notes.push(`duration ${dur} vs 24k ${q24.durationMs}`);
    if (rmsDbfs(pcm) < -45) notes.push("nearly silent");
    const ok = notes.length === 0;
    if (!ok) problems.push(`${file}: ${notes.join("; ")}`);
    rows.push({ file, format: "raw G.711 mu-law (no header)", sampleRate: 8000, channels: 1, durationMs: Math.round(dur), bytes: bytes.length, rmsDb: db(rmsDbfs(pcm)), peakDb: db(peakDbfs(pcm)), clipped: 0, ok, notes: notes.join("; ") });
  } else problems.push(`${file}: missing`);
}
if (q24 && q16 && Math.abs(q24.durationMs - q16.durationMs) > 5) problems.push("question_16k/24k duration mismatch");

// dialog ---------------------------------------------------------------------------------------
const dm = checkWav("dialog_mono_16k.wav", 16000, 1, 50000, 70000);
const ds = checkWav("dialog_stereo_16k.wav", 16000, 2, 50000, 70000);
const dialogChecks: Record<string, unknown> = {};
if (dm && ds && existsSync(fx("dialog_script.json"))) {
  const script = JSON.parse(readFileSync(fx("dialog_script.json"), "utf8")) as {
    duration_ms: number;
    gap_ms: number;
    turns: { index: number; speaker: "adjuster" | "claimant"; start_ms: number; end_ms: number; text: string }[];
  };
  const [L, R] = deinterleave(ds.samples, 2) as [Int16Array, Int16Array];
  const issues: string[] = [];
  if (dm.frames !== ds.frames) issues.push(`mono frames ${dm.frames} != stereo frames ${ds.frames}`);
  if (Math.abs(script.duration_ms - dm.durationMs) > 1) issues.push(`script duration ${script.duration_ms} != wav ${dm.durationMs}`);
  const last = script.turns.at(-1)!;
  if (Math.abs(last.end_ms - dm.durationMs) > 1) issues.push(`last turn end ${last.end_ms} != duration`);
  const perTurn: unknown[] = [];
  let prevEnd = -1;
  for (const t of script.turns) {
    const a = msToFrames(t.start_ms, 16000);
    const b = msToFrames(t.end_ms, 16000);
    const own = t.speaker === "adjuster" ? L : R;
    const other = t.speaker === "adjuster" ? R : L;
    const ownDb = rmsDbfs(own.subarray(a, b));
    const otherDb = rmsDbfs(other.subarray(a, b));
    const monoMatches = dm.samples.subarray(a, b).every((v, i) => v === own[a + i]);
    if (otherDb !== -Infinity) issues.push(`turn ${t.index}: other channel not silent (${db(otherDb)} dB)`);
    if (ownDb < -40) issues.push(`turn ${t.index}: own channel too quiet (${db(ownDb)} dB)`);
    if (!monoMatches) issues.push(`turn ${t.index}: mono != own channel`);
    if (prevEnd >= 0) {
      const gap = t.start_ms - prevEnd;
      if (Math.abs(gap - script.gap_ms) > 1) issues.push(`turn ${t.index}: gap ${gap} ms`);
      const g = dm.samples.subarray(msToFrames(prevEnd, 16000) + 1, a - 1);
      if (rmsDbfs(g) !== -Infinity) issues.push(`turn ${t.index}: gap not silent`);
    }
    prevEnd = t.end_ms;
    perTurn.push({ index: t.index, speaker: t.speaker, start_ms: t.start_ms, end_ms: t.end_ms, own_db: db(ownDb), other_db: db(otherDb) });
  }
  dialogChecks.turns = perTurn;
  dialogChecks.issues = issues;
  dialogChecks.ok = issues.length === 0;
  for (const i of issues) problems.push(`dialog: ${i}`);
} else problems.push("dialog: files or script missing");

// codeswitch -----------------------------------------------------------------------------------
checkWav("codeswitch_16k.wav", 16000, 1, 5000, 20000);

// optional transcription (content) check --------------------------------------------------------
// Uses gpt-4o-transcribe (the stricter model: it is the one that caught the ambiguous "ek"/"eight"
// digit in codeswitch v1). Each expectation is matched against the transcript after normalization
// (lowercase, Devanagari digits -> ASCII, everything except letters/digits removed).
const TRANSCRIBE_MODEL = "gpt-4o-transcribe";
const normalize = (s: string) =>
  s
    .toLowerCase()
    .replace(/[०-९]/g, (d) => String(d.charCodeAt(0) - 0x0966))
    .replace(/[^\p{L}\p{N}]+/gu, "");
const CONTENT: { file: string; label: string; audio: () => Buffer; prompt?: string; expect: string[] }[] = [
  { file: "question_16k.wav", label: "question_16k.wav", audio: () => readFileSync(fx("question_16k.wav")), expect: ["481529", "hasntarrived"] },
  {
    file: "question_8k.mulaw",
    label: "question_8k.mulaw (decoded to 8 kHz PCM16 WAV for upload)",
    audio: () => encodeWav(mulawDecode(readFileSync(fx("question_8k.mulaw"))), 8000, 1),
    expect: ["481529", "hasntarrived"],
  },
  {
    file: "codeswitch_16k.wav",
    label: "codeswitch_16k.wav",
    audio: () => readFileSync(fx("codeswitch_16k.wav")),
    prompt: "Hinglish customer support call (Hindi and English mixed).",
    expect: ["481529", "status"],
  },
  {
    file: "dialog_mono_16k.wav",
    label: "dialog_mono_16k.wav",
    audio: () => readFileSync(fx("dialog_mono_16k.wav")),
    expect: ["danielreyes", "markdonnelly", "7740391", "september15", "5pm", "7pm", "1420maple", "3450", "125", "500", "4155550137", "88birchwood", "44812", "10am"],
  },
];
const transcripts: Record<string, unknown> = {};
if (CONTENT_MODE) {
  const { OPENAI_API_KEY } = await import("../lib/env.ts");
  for (const c of CONTENT) {
    const form = new FormData();
    form.append("model", TRANSCRIBE_MODEL);
    form.append("file", new Blob([c.audio()], { type: "audio/wav" }), c.file.replace(/\.mulaw$/, ".wav"));
    if (c.prompt) form.append("prompt", c.prompt);
    log.event("http", { phase: "request", method: "POST", url: "https://api.openai.com/v1/audio/transcriptions", body: { model: TRANSCRIBE_MODEL, file: c.label, prompt: c.prompt } });
    const t = performance.now();
    const res = await fetch("https://api.openai.com/v1/audio/transcriptions", { method: "POST", headers: { Authorization: `Bearer ${OPENAI_API_KEY}` }, body: form });
    const body = (await res.json()) as { text?: string };
    const ms = Math.round(performance.now() - t);
    log.event("http", { phase: "response", status: res.status, ms, body });
    const norm = normalize(body.text ?? "");
    const missing = c.expect.filter((e) => !norm.includes(e));
    if (res.status !== 200) problems.push(`${c.file}: transcription HTTP ${res.status}`);
    else if (missing.length) problems.push(`${c.file}: content check missing [${missing.join(", ")}]`);
    transcripts[c.label] = { model: TRANSCRIBE_MODEL, status: res.status, ms, text: body.text, expect: c.expect, missing };
  }
}

const report = { validated_at: new Date().toISOString(), ok: problems.length === 0, problems, files: rows, dialog: dialogChecks, transcripts };
writeFileSync(resolve(OUT_DIR, `fixtures-validation${SUFFIX}.json`), JSON.stringify(report, null, 2));
log.result(problems.length ? "FAIL" : "PASS", report);
log.close();

console.table(rows.map(({ notes, ...r }) => ({ ...r, notes: notes || "" })));
console.log(`dialog channel/timing checks: ${dialogChecks.ok ? "OK" : "ISSUES"}`);
for (const [f, t] of Object.entries(transcripts)) {
  const { text, missing } = t as { text?: string; missing: string[] };
  console.log(`\n[transcript] ${f} -> ${missing.length ? `MISSING ${missing.join(", ")}` : "content OK"}\n  ${text}`);
}
console.log(problems.length ? `\nPROBLEMS:\n - ${problems.join("\n - ")}` : "\nALL FIXTURES OK");
process.exitCode = problems.length ? 1 : 0;
