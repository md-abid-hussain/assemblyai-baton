/**
 * t06 - streaming TTS to raw PCM for a BYO-TTS pipeline (AssemblyAI Realtime STT -> LLM -> TTS):
 *   - gpt-4o-mini-tts-2025-12-15, voices marin + cedar, 2 reps each: TTFB, chunk timeline, real-time factor
 *   - alias gpt-4o-mini-tts and tts-1 (alloy) as baselines; past-shutdown snapshot probe
 *   - response_format "wav" once to read the header (confirms 24 kHz / 16-bit / mono)
 *   - stream_format "sse" once (raw fetch) to capture the event shape
 *   - streaming 24k -> 8k mu-law (Twilio) on real chunks vs the batch lib path
 * Out: out/openai-t06-tts.jsonl, out/tts_sample.wav (marin), out/tts_sample_cedar.wav
 */
import { resolve } from "node:path";
import { OPENAI_API_KEY, OUT_DIR } from "../lib/env.ts";
import { bytesToPcm16, mulawEncode, peakDbfs, resampleLinear, rmsDbfs } from "../lib/audio.ts";
import { createLogger } from "../lib/log.ts";
import { decodeWav, writeWav } from "../lib/wav.ts";
import { ByteFramer, MODELS, openSpeechPcmStream, Pcm24kToMulaw8k, TTS_PCM_RATE } from "./client.ts";
import { errInfo, header, oa, stats } from "./common.ts";

const log = createLogger("openai-t06-tts");
header(log, "t06-tts-stream");

const TEXT =
  "Thanks for calling Harbor Point. I can see your claim, C L 4 4 8 1 2, and an appraiser will call you on Friday at 10 a.m. Is there anything else I can help you with today?";
const INSTRUCTIONS = "Warm, calm and professional phone-agent tone. Moderate pace.";

interface RunOut {
  label: string;
  ok: boolean;
  ttfb_ms?: number | null;
  headers_ms?: number;
  total_ms?: number | null;
  bytes?: number;
  audio_ms?: number;
  rtf?: number;
  network_chunks?: number;
  odd_chunks?: number;
  chunk_bytes?: ReturnType<typeof stats>;
  arrival_span_ms?: number;
  content_type?: string | null;
  request_id?: string | undefined;
  error?: unknown;
}

const runs: RunOut[] = [];
const pcmByLabel = new Map<string, Buffer>();

async function run(label: string, model: string, voice: string, instructions?: string): Promise<void> {
  const req = { model, voice, input: TEXT, response_format: "pcm", ...(instructions ? { instructions } : {}) };
  log.out({ type: "POST /v1/audio/speech", label, body: req });
  try {
    const { stats: s, chunks } = await openSpeechPcmStream(oa, { model, voice, input: TEXT, ...(instructions ? { instructions } : {}) });
    const parts: Buffer[] = [];
    const arrivals: { at: number; bytes: number }[] = [];
    for await (const c of chunks) {
      parts.push(c.pcm);
      arrivals.push({ at: c.atMs, bytes: c.pcm.length });
      log.tally(`${label} pcm chunk`, c.pcm.length);
    }
    const pcm = Buffer.concat(parts);
    pcmByLabel.set(label, pcm);
    const out: RunOut = {
      label,
      ok: s.status === 200 && pcm.length > 0,
      ttfb_ms: s.ttfbMs,
      headers_ms: s.headersMs,
      total_ms: s.totalMs,
      bytes: s.bytes,
      audio_ms: s.audioMs,
      rtf: s.totalMs ? Math.round((s.totalMs / s.audioMs) * 100) / 100 : undefined,
      network_chunks: s.networkChunks,
      odd_chunks: s.oddChunks,
      chunk_bytes: stats(arrivals.map((a) => a.bytes)),
      arrival_span_ms: arrivals.length ? Math.round(arrivals.at(-1)!.at - arrivals[0]!.at) : 0,
      content_type: s.contentType,
      request_id: s.requestId,
    };
    runs.push(out);
    log.in({ type: "speech.stream.done", ...out, headers: s.headers, first_arrivals: arrivals.slice(0, 6), last_arrivals: arrivals.slice(-3), level: { rms_dbfs: rmsDbfs(bytesToPcm16(pcm)), peak_dbfs: peakDbfs(bytesToPcm16(pcm)) } });
    console.log(
      `${label.padEnd(34)} headers=${s.headersMs}ms TTFB=${s.ttfbMs}ms total=${s.totalMs}ms audio=${s.audioMs}ms RTF=${out.rtf} chunks=${s.networkChunks} (odd ${s.oddChunks}) median=${out.chunk_bytes?.median}B span=${out.arrival_span_ms}ms ct=${s.contentType}`,
    );
  } catch (e) {
    runs.push({ label, ok: false, error: errInfo(e) });
    log.error(e, { label });
    console.log(`${label} ERROR ${JSON.stringify(errInfo(e))}`);
  }
}

// 1) current model, 2 voices x 2 reps
for (let rep = 0; rep < 2; rep++) {
  await run(`${MODELS.tts}/marin#${rep}`, MODELS.tts, "marin", INSTRUCTIONS);
  await run(`${MODELS.tts}/cedar#${rep}`, MODELS.tts, "cedar", INSTRUCTIONS);
}
// 2) baselines
await run("gpt-4o-mini-tts(alias)/marin", "gpt-4o-mini-tts", "marin", INSTRUCTIONS);
await run("tts-1/alloy", "tts-1", "alloy");
// 3) past-shutdown snapshot (listed with shutdown_date 2026-07-23 in t01)
await run("gpt-4o-mini-tts-2025-03-20/marin", "gpt-4o-mini-tts-2025-03-20", "marin");

// save samples
const marin = pcmByLabel.get(`${MODELS.tts}/marin#0`);
const cedar = pcmByLabel.get(`${MODELS.tts}/cedar#0`);
if (marin) writeWav(resolve(OUT_DIR, "tts_sample.wav"), bytesToPcm16(marin), TTS_PCM_RATE, 1);
if (cedar) writeWav(resolve(OUT_DIR, "tts_sample_cedar.wav"), bytesToPcm16(cedar), TTS_PCM_RATE, 1);

// 4) wav header check (non-streaming read) -> is "pcm" really 24 kHz/16-bit/mono?
let wavHeader: Record<string, unknown> = {};
try {
  const t0 = performance.now();
  const res = await oa.audio.speech.create({ model: MODELS.tts, voice: "marin", input: "Header check.", response_format: "wav" });
  const buf = Buffer.from(await res.arrayBuffer());
  const w = decodeWav(buf);
  wavHeader = { ms: Math.round(performance.now() - t0), content_type: res.headers.get("content-type"), bytes: buf.length, riff_size_field: buf.readUInt32LE(4), data_size_field: buf.readUInt32LE(40), sampleRate: w.sampleRate, channels: w.channels, bitsPerSample: w.bitsPerSample, formatTag: w.formatTag, durationMs: Math.round(w.durationMs) };
} catch (e) {
  wavHeader = { error: errInfo(e) };
}
log.note("wav header", wavHeader);
console.log("wav header:", JSON.stringify(wavHeader));

// 5) stream_format "sse" (raw fetch so the wire format is visible)
let sse: Record<string, unknown> = {};
try {
  const body = { model: MODELS.tts, voice: "cedar", input: "Server-sent events check.", response_format: "pcm", stream_format: "sse" };
  log.out({ type: "POST /v1/audio/speech (sse)", body });
  const t0 = performance.now();
  const res = await fetch("https://api.openai.com/v1/audio/speech", { method: "POST", headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const headersMs = Math.round(performance.now() - t0);
  const text = await res.text();
  const crlf = text.includes("\r\n");
  const events = text
    .split(/\r?\n\r?\n/)
    .map((b) => b.trim())
    .filter(Boolean)
    .map((b) => {
      const dataLine = b.split(/\r?\n/).find((l) => l.startsWith("data:"));
      const evLine = b.split(/\r?\n/).find((l) => l.startsWith("event:"));
      try {
        return { event: evLine?.slice(6).trim(), data: dataLine ? (JSON.parse(dataLine.slice(5).trim()) as Record<string, unknown>) : null };
      } catch {
        return { event: evLine?.slice(6).trim(), raw: b.slice(0, 200) };
      }
    });
  const types = events.map((e) => (e.data?.type as string | undefined) ?? e.event ?? "?");
  let audioBytes = 0;
  for (const e of events) if (typeof e.data?.audio === "string") audioBytes += Buffer.from(e.data.audio, "base64").length;
  const nonAudio = events.filter((e) => e.data && typeof e.data.audio !== "string").map((e) => e.data);
  sse = { status: res.status, headers_ms: headersMs, content_type: res.headers.get("content-type"), line_endings: crlf ? "CRLF" : "LF", raw_head: text.slice(0, 60).replace(/[A-Za-z0-9+/=]{40,}/g, "<b64>"), events: events.length, type_counts: types.reduce<Record<string, number>>((a, t) => ((a[t] = (a[t] ?? 0) + 1), a), {}), audio_bytes: audioBytes, first_event: events[0], non_audio_events: nonAudio };
  if (!res.ok) sse.body = text.slice(0, 400);
} catch (e) {
  sse = { error: errInfo(e) };
}
log.note("sse", sse); // the logger replaces base64 `audio` with {bytes}
console.log("sse:", JSON.stringify({ ...sse, first_event: undefined }));

// 6) streaming 24k -> mu-law 8k on the real marin chunks, framed at 20 ms (160 B), vs batch path
let twilio: Record<string, unknown> = {};
if (marin) {
  const conv = new Pcm24kToMulaw8k();
  const framer = new ByteFramer(160);
  const frames: Buffer[] = [];
  // replay in the same odd-ish sizes the network produced (use 4096-byte slices of the even-aligned PCM)
  for (let off = 0; off < marin.length; off += 4096) frames.push(...framer.push(conv.push(bytesToPcm16(marin.subarray(off, off + 4096)))));
  frames.push(...framer.push(conv.flush()));
  const tail = framer.flush();
  const streamed = Buffer.concat([...frames, ...(tail ? [tail] : [])]);
  const batch = Buffer.from(mulawEncode(resampleLinear(bytesToPcm16(marin), 24000, 8000)));
  let diff = 0;
  for (let i = 0; i < Math.min(batch.length, streamed.length); i++) if (batch[i] !== streamed[i]) diff++;
  // batch keeps floor(n/3) samples, the streamer emits ceil(n/3) (one extra final sample at most)
  twilio = { frames_160B: frames.length, tail_bytes: tail?.length ?? 0, streamed_bytes: streamed.length, batch_bytes: batch.length, differing_bytes_in_common_prefix: diff, identical_prefix: diff === 0 && streamed.length - batch.length <= 1 && streamed.length >= batch.length };
}
log.note("twilio mu-law conversion", twilio);
console.log("twilio:", JSON.stringify(twilio));

const main = runs.filter((r) => r.label.startsWith(MODELS.tts));
const ttfb = main.filter((r) => r.ok).map((r) => r.ttfb_ms ?? 0);
log.result(main.every((r) => r.ok) && wavHeader.sampleRate === 24000 ? "PASS" : "PARTIAL", {
  request_shape: "POST /v1/audio/speech {model:'gpt-4o-mini-tts-2025-12-15', voice, input, instructions, response_format:'pcm'} -> chunked body",
  ttfb_ms: stats(ttfb),
  runs,
  wav_header: wavHeader,
  sse: { ...sse, first_event: undefined },
  twilio,
  samples: ["out/tts_sample.wav", "out/tts_sample_cedar.wav"],
});
log.close();
