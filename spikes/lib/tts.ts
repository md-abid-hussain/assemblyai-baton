/**
 * tts.ts - OpenAI TTS -> raw PCM16 24 kHz mono, with an on-disk cache so re-running fixture
 * generation costs nothing. Model/voices confirmed via GET /v1/models on 2026-09-24:
 * `gpt-4o-mini-tts` (+ snapshots `gpt-4o-mini-tts-2025-12-15`, `-2025-03-20`), `tts-1`, `tts-1-hd`.
 * `response_format: "pcm"` = 24 kHz, 16-bit signed LE, mono, no header (research/09 section 7.3).
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import OpenAI from "openai";
import { OPENAI_API_KEY, SPIKES_ROOT } from "./env.ts";
import { bytesToPcm16 } from "./audio.ts";
import type { JsonlLogger } from "./log.ts";

export const TTS_SAMPLE_RATE = 24000;
export const DEFAULT_TTS_MODEL = "gpt-4o-mini-tts-2025-12-15";
export const TTS_CACHE_DIR = resolve(SPIKES_ROOT, ".cache", "tts");

export interface TtsRequest {
  input: string;
  voice: string;
  model?: string;
  /** Style prompt (gpt-4o-mini-tts only): accent, tone, pace... */
  instructions?: string;
  speed?: number;
}

export interface TtsResult {
  samples: Int16Array;
  sampleRate: 24000;
  bytes: number;
  durationMs: number;
  cached: boolean;
  /** Request wall time (0 when cached). */
  ms: number;
  requestId?: string;
}

let client: OpenAI | undefined;
const openai = () => (client ??= new OpenAI({ apiKey: OPENAI_API_KEY }));

/** Synthesize `req.input` to PCM16 @ 24 kHz mono. Cached by request hash under spikes/.cache/tts/. */
export async function ttsPcm24k(req: TtsRequest, log?: JsonlLogger): Promise<TtsResult> {
  const body = {
    model: req.model ?? DEFAULT_TTS_MODEL,
    voice: req.voice,
    input: req.input,
    response_format: "pcm" as const,
    ...(req.instructions ? { instructions: req.instructions } : {}),
    ...(req.speed ? { speed: req.speed } : {}),
  };
  const hash = createHash("sha256").update(JSON.stringify(body)).digest("hex").slice(0, 16);
  const cachePath = resolve(TTS_CACHE_DIR, `${hash}.pcm`);
  if (existsSync(cachePath)) {
    const buf = readFileSync(cachePath);
    const samples = bytesToPcm16(buf);
    log?.event("http", { phase: "cache-hit", endpoint: "POST /v1/audio/speech", request: body, cache: cachePath, bytes: buf.length });
    return { samples, sampleRate: 24000, bytes: buf.length, durationMs: (samples.length / TTS_SAMPLE_RATE) * 1000, cached: true, ms: 0 };
  }
  log?.event("http", { phase: "request", endpoint: "POST https://api.openai.com/v1/audio/speech", request: body });
  const t = performance.now();
  const res = await openai().audio.speech.create(body);
  const buf = Buffer.from(await res.arrayBuffer());
  const ms = Math.round(performance.now() - t);
  const requestId = res.headers.get("x-request-id") ?? undefined;
  log?.event("http", {
    phase: "response",
    status: res.status,
    ms,
    bytes: buf.length,
    content_type: res.headers.get("content-type"),
    openai_processing_ms: res.headers.get("openai-processing-ms"),
    request_id: requestId,
  });
  if (buf.length % 2 !== 0) throw new Error(`TTS returned odd byte count ${buf.length} (not PCM16?)`);
  mkdirSync(TTS_CACHE_DIR, { recursive: true });
  writeFileSync(cachePath, buf);
  const samples = bytesToPcm16(buf);
  return { samples, sampleRate: 24000, bytes: buf.length, durationMs: (samples.length / TTS_SAMPLE_RATE) * 1000, cached: false, ms, ...(requestId ? { requestId } : {}) };
}
