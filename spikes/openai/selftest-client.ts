/** selftest-client.ts - offline checks for the pure helpers in client.ts (no network). Out: out/openai-selftest.jsonl */
import { mulawEncode, resampleLinear } from "../lib/audio.ts";
import { createLogger } from "../lib/log.ts";
import { ByteFramer, normalizeChatBodyForReasoningModel, Pcm24kToMulaw8k, pickModels, SentenceBuffer, StreamingDecimator } from "./client.ts";

const log = createLogger("openai-selftest");
const results: { name: string; ok: boolean; detail?: unknown }[] = [];
const check = (name: string, ok: boolean, detail?: unknown) => {
  results.push({ name, ok, ...(detail !== undefined ? { detail } : {}) });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail !== undefined ? ` ${JSON.stringify(detail)}` : ""}`);
};

// SentenceBuffer: splits on sentence ends, not on "a.m." / "Ms." / initials, flush returns the tail
{
  const sb = new SentenceBuffer();
  const text = "Thanks, Ms. Shah. An appraiser will call Friday at 10 a.m. to inspect the car. Is there anything else? Bye";
  const out: string[] = [];
  for (const piece of text.match(/.{1,7}/g) ?? []) out.push(...sb.push(piece));
  const tail = sb.flush();
  check(
    "SentenceBuffer splits (not on Ms./a.m.)",
    JSON.stringify(out) === JSON.stringify(["Thanks, Ms. Shah.", "An appraiser will call Friday at 10 a.m. to inspect the car.", "Is there anything else?"]) && tail === "Bye",
    { out, tail },
  );
  const sb2 = new SentenceBuffer();
  const out2 = [...sb2.push("Sure. "), ...sb2.push("I can help with that claim today. ")];
  check("SentenceBuffer merges short 'Sure.' into the next sentence", JSON.stringify(out2) === JSON.stringify(["Sure. I can help with that claim today."]), { out2 });
}

// StreamingDecimator / Pcm24kToMulaw8k: identical to the batch path for odd chunk sizes
{
  const n = 24000 + 7;
  const x = new Int16Array(n);
  for (let i = 0; i < n; i++) x[i] = Math.round(8000 * Math.sin((2 * Math.PI * 440 * i) / 24000) + 3000 * Math.sin((2 * Math.PI * 5000 * i) / 24000));
  const batch = resampleLinear(x, 24000, 8000);
  const dec = new StreamingDecimator(3, 24000);
  const parts: Int16Array[] = [];
  let off = 0;
  for (const size of [1, 2, 5, 31, 32, 33, 100, 997, 4096]) {
    parts.push(dec.push(x.subarray(off, off + size)));
    off += size;
  }
  while (off < n) {
    parts.push(dec.push(x.subarray(off, off + 777)));
    off += 777;
  }
  parts.push(dec.flush());
  const streamed = Int16Array.from(parts.flatMap((p) => [...p]));
  let diff = 0;
  for (let i = 0; i < batch.length; i++) if (batch[i] !== streamed[i]) diff++;
  check("StreamingDecimator == batch resampleLinear (prefix)", diff === 0 && streamed.length - batch.length <= 1, { batch: batch.length, streamed: streamed.length, diff });
  const conv = new Pcm24kToMulaw8k();
  const mu = Buffer.concat([Buffer.from(conv.push(x.subarray(0, 12345))), Buffer.from(conv.push(x.subarray(12345))), Buffer.from(conv.flush())]);
  const muBatch = Buffer.from(mulawEncode(batch));
  check("Pcm24kToMulaw8k == batch mulaw (prefix)", muBatch.equals(mu.subarray(0, muBatch.length)), { batch: muBatch.length, streamed: mu.length });
}

// ByteFramer
{
  const f = new ByteFramer(160);
  const frames = [...f.push(new Uint8Array(100)), ...f.push(new Uint8Array(250)), ...f.push(new Uint8Array(10))];
  const tail = f.flush();
  check("ByteFramer 360 B -> 2x160 + 40 tail", frames.length === 2 && frames.every((b) => b.length === 160) && tail?.length === 40);
}

// normalizeChatBodyForReasoningModel
{
  const a = normalizeChatBodyForReasoningModel({ model: "gpt-6-luna", messages: [], tools: [{}], temperature: 0.7, max_tokens: 256 });
  check("shim: tools -> effort none, max_tokens -> max_completion_tokens, keeps temperature", a.reasoning_effort === "none" && a.max_completion_tokens === 256 && !("max_tokens" in a) && a.temperature === 0.7, a);
  const b = normalizeChatBodyForReasoningModel({ model: "gpt-6-luna", messages: [], temperature: 0.7 }, { effort: "low" });
  check("shim: no tools + effort low drops temperature", b.reasoning_effort === "low" && !("temperature" in b), b);
  const c = normalizeChatBodyForReasoningModel({ model: "gpt-6-luna", messages: [], tools: [{}], reasoning_effort: "high" });
  check("shim: tools force effort none even if caller asked high", c.reasoning_effort === "none", c);
}

// pickModels
{
  const t = pickModels(["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-6-astra", "gpt-6-sol", "gpt-6-luna", "gpt-4o-mini-tts-2025-12-15", "gpt-realtime-2.1", "gpt-transcribe"]);
  check("pickModels tiers", t.reasoning === "gpt-6-astra" && t.balanced === "gpt-6-sol" && t.fast === "gpt-6-luna" && t.tts.length === 1 && t.realtime.length === 1 && t.transcribe.length === 1, t);
}

const failed = results.filter((r) => !r.ok).length;
log.result(failed ? "FAIL" : "PASS", { results });
log.close();
process.exit(failed ? 1 : 0);
