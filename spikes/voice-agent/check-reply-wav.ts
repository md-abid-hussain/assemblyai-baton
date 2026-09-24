/** check-reply-wav.ts - verify out/agent_reply.wav (format + what it says, via gpt-4o-transcribe). */
import { resolve } from "node:path";
import { readWav } from "../lib/wav.ts";
import { OUT_DIR, transcribeWav } from "./harness.ts";
for (const f of ["agent_reply.wav", "agent_after_bargein.wav"]) {
  const p = resolve(OUT_DIR, f);
  const w = readWav(p);
  console.log(f, { sampleRate: w.sampleRate, channels: w.channels, durationMs: Math.round(w.durationMs) }, JSON.stringify(await transcribeWav(p)));
}
