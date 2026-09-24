/**
 * probe-codeswitch-digits.ts - cross-check what the TTS actually said for the order number in
 * codeswitch_16k.wav using several OpenAI transcribers (~12 s of audio each, < $0.01 total).
 *   npx tsx scripts/probe-codeswitch-digits.ts [file]
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { FIXTURES_DIR, OPENAI_API_KEY } from "../lib/env.ts";
import { createLogger } from "../lib/log.ts";

const file = process.argv[2] ?? "codeswitch_16k.wav";
const log = createLogger(`probe-${file.replace(/\.wav$/, "")}`);
const audio = readFileSync(resolve(FIXTURES_DIR, file));
const variants: { model: string; language?: string; prompt?: string; extra?: Record<string, string> }[] = [
  { model: "gpt-4o-transcribe" },
  { model: "gpt-4o-transcribe", language: "en" },
  { model: "whisper-1", language: "en", extra: { response_format: "verbose_json", "timestamp_granularities[]": "word" } },
];
for (const v of variants) {
  const form = new FormData();
  form.append("model", v.model);
  form.append("file", new Blob([audio], { type: "audio/wav" }), file);
  if (v.language) form.append("language", v.language);
  if (v.prompt) form.append("prompt", v.prompt);
  for (const [k, val] of Object.entries(v.extra ?? {})) form.append(k, val);
  const t = performance.now();
  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", { method: "POST", headers: { Authorization: `Bearer ${OPENAI_API_KEY}` }, body: form });
  const body = (await res.json()) as { text?: string; words?: { word: string; start: number; end: number }[] };
  const ms = Math.round(performance.now() - t);
  log.event("http", { phase: "response", request: v, status: res.status, ms, body });
  console.log(`\n[${v.model}${v.language ? ` lang=${v.language}` : ""}] ${res.status} ${ms}ms\n${body.text}`);
  if (body.words) console.log(body.words.filter((w) => /\d|one|four|eight|five|two|nine|number/i.test(w.word)).map((w) => `${w.word}@${w.start.toFixed(2)}-${w.end.toFixed(2)}`).join("  "));
}
log.close();
