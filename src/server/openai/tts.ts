/**
 * server/openai/tts.ts - cached OpenAI TTS for simulated calls and customer clips (PLATFORM §7.5 step 2; WP17,
 * imported by WP11). One clip = one `/v1/audio/speech` request with the PINNED `gpt-4o-mini-tts-2025-12-15`,
 * `response_format:"pcm"` (24 kHz s16le mono), streamed through `openSpeechPcmStream` (odd HTTP chunks carried).
 *
 * - Cache: every clip is keyed by `sha256(model|voice|instructions|text)` in a `TtsCacheStore` (`tts_cache` on the
 *   server, a file cache in scripts). A hit costs $0 and never touches the network or the ledger. Concurrent
 *   requests for the same key share one upstream call.
 * - Spend: every upstream call RESERVES in the ledger first (provider `openai`, action `tts`) and SETTLES from the
 *   character count (the PCM endpoint returns no `usage`; PLATFORM §7.5 "Cost"). A refused reservation throws
 *   `E_BUDGET` before any request is made. A request that failed before any audio arrived is released.
 * - Voices: only `marin` and `cedar` (the two verified live).
 *
 * No secrets are read here: the OpenAI client is injected.
 */
import "server-only";

import { createHash } from "node:crypto";

import OpenAI from "openai";

import { BatonError } from "../../core/contracts/errors";
import { SIM_TTS_MODEL, type TtsCacheStore, type TtsClip, type TtsRequest } from "../../core/contracts/ext/wp17-sim";
import type { SpendLedger } from "../../core/contracts/services";
import { log } from "../log";
import { openSpeechPcmStream, TTS_PCM_RATE, TTS_VOICES } from "./client";

export { TTS_PCM_RATE } from "./client";

/** Pinned snapshot; never the alias (research/10 §3.9). */
export const TTS_MODEL = SIM_TTS_MODEL;

/**
 * Settlement from the character count: `TTS_USD_PER_REQUEST + chars × TTS_USD_PER_CHAR`. Calibrated live in the
 * WP17·1 smoke (docs/notes/wp17.md): the SSE `speech.audio.done` usage showed 26.8 audio tokens per second of speech
 * ($12/1M → ≈ $0.019/min) and ≈ 30 input tokens per request (the instructions count); clips run ≈ 1 s of edge padding
 * + ≈ 45 ms per character. So ≈ $0.0003 per request + ≈ $0.0000145 per char, rounded UP to $0.0004 + $16/1M chars
 * (the smoke's 12 clips / 342 chars: usage ≈ $0.0092, settled $0.0103). A 14-clip, 1200-char sim ≈ $0.025.
 */
export const TTS_USD_PER_REQUEST = 0.0004;
export const TTS_USD_PER_CHAR = 16 / 1_000_000;
/** Per-line guard (the whole sim script is ≤ 1200 chars; the API limit is 4096). */
export const TTS_MAX_CHARS = 600;
export const TTS_TIMEOUT_MS = 30_000;

const ttsLog = log.child({ component: "tts" });

export const isTtsVoice = (v: string): v is (typeof TTS_VOICES)[number] => (TTS_VOICES as readonly string[]).includes(v);

/** The cache key (PLATFORM §2.4 `tts_cache.hash`). Text is used exactly as given (callers normalize whitespace). */
export function ttsHash(model: string, voice: string, instructions: string, text: string): string {
  return createHash("sha256").update(`${model}|${voice}|${instructions}|${text}`, "utf8").digest("hex");
}

/** Settlement for one clip from its character count, rounded to 1e-6 USD. */
export function ttsCostUsd(text: string): number {
  return Math.round((TTS_USD_PER_REQUEST + Math.max(1, text.length) * TTS_USD_PER_CHAR) * 1e6) / 1e6;
}

/** Duration of PCM16 mono at 24 kHz. */
export const pcm24kDurationMs = (bytes: number): number => Math.round(((bytes / 2) * 1000) / TTS_PCM_RATE);

/** Collapse whitespace so equal lines share a cache row. */
export const normalizeTtsText = (text: string): string => text.replace(/\s+/g, " ").trim();

export interface TtsDeps {
  /** Lazily created client (keeps the key out of this module). */
  openai: () => OpenAI;
  cache: TtsCacheStore;
  /** `getLimitsAuthority().ledger`; null = spend not recorded (unit tests only). */
  ledger: () => SpendLedger | null;
  /** Ledger `env` (BATON_DEPLOY_ID on servers, `dev-wp17` in WP17's scripts). */
  env: () => string;
  model?: string;
  timeoutMs?: number;
  /** Test seam for the upstream call; defaults to `openSpeechPcmStream`. */
  speak?: (client: OpenAI, o: { input: string; voice: string; instructions: string; model: string; signal: AbortSignal }) => Promise<Uint8Array>;
}

/** Default upstream: stream the PCM and concatenate (even-aligned chunks). */
async function speakPcm(client: OpenAI, o: { input: string; voice: string; instructions: string; model: string; signal: AbortSignal }): Promise<Uint8Array> {
  const { chunks } = await openSpeechPcmStream(client, { input: o.input, voice: o.voice, instructions: o.instructions, model: o.model, signal: o.signal });
  const parts: Uint8Array[] = [];
  let n = 0;
  try {
    for await (const c of chunks) {
      parts.push(c.pcm);
      n += c.pcm.byteLength;
    }
  } catch (e) {
    // Audio already arrived: surface how much, so the caller settles instead of releasing.
    throw Object.assign(e instanceof Error ? e : new Error(String(e)), { receivedBytes: n });
  }
  const out = new Uint8Array(n);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.byteLength;
  }
  return out;
}

function toBatonError(e: unknown): BatonError {
  if (e instanceof BatonError) return e;
  if (e instanceof OpenAI.APIConnectionTimeoutError || (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError"))) {
    return new BatonError("E_OPENAI_TIMEOUT", "The voice service took too long.", { cause: e });
  }
  if (e instanceof OpenAI.APIError && e.status === 429) return new BatonError("E_OPENAI_RATE", "The voice service is busy; try again shortly.", { cause: e });
  return new BatonError("E_INTERNAL", "The voice service failed.", { cause: e });
}

export class TtsService {
  private readonly inflight = new Map<string, Promise<TtsClip>>();
  readonly model: string;

  constructor(private readonly d: TtsDeps) {
    this.model = d.model ?? TTS_MODEL;
  }

  hashOf(r: Pick<TtsRequest, "voice" | "instructions" | "text">): string {
    return ttsHash(this.model, r.voice, r.instructions, normalizeTtsText(r.text));
  }

  /** One clip: cache → (reserve → speak → settle → cache). Throws `BatonError`. */
  async synth(r: TtsRequest): Promise<TtsClip> {
    const text = normalizeTtsText(r.text);
    if (!text) throw new BatonError("E_BAD_REQUEST", "Nothing to say.");
    if (text.length > TTS_MAX_CHARS) throw new BatonError("E_BAD_REQUEST", `A spoken line is limited to ${TTS_MAX_CHARS} characters.`);
    if (!isTtsVoice(r.voice)) throw new BatonError("E_BAD_REQUEST", `Voice "${r.voice}" is not supported.`);
    const hash = ttsHash(this.model, r.voice, r.instructions, text);
    const running = this.inflight.get(hash);
    if (running) return { ...(await running), cached: true, usd: 0 };
    const p = this.fetchOrSpeak(hash, { ...r, text }).finally(() => this.inflight.delete(hash));
    this.inflight.set(hash, p);
    return p;
  }

  /** Several clips with bounded concurrency, results in input order. */
  async synthMany(reqs: readonly TtsRequest[], concurrency = 3): Promise<TtsClip[]> {
    const out = new Array<TtsClip>(reqs.length);
    let next = 0;
    const worker = async () => {
      while (next < reqs.length) {
        const i = next++;
        out[i] = await this.synth(reqs[i]!);
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, reqs.length)) }, worker));
    return out;
  }

  private async fetchOrSpeak(hash: string, r: TtsRequest): Promise<TtsClip> {
    const hit = await this.d.cache.get(hash);
    if (hit && hit.pcm24k.byteLength > 0) return { hash, pcm24k: hit.pcm24k, durationMs: hit.durationMs, cached: true, usd: 0 };

    const usd = ttsCostUsd(r.text);
    const ledger = this.d.ledger();
    let reservation: string | null = null;
    if (ledger) {
      const res = await ledger.reserve({ provider: "openai", action: "tts", refId: r.refId, estUsd: usd, env: this.d.env() });
      if (!res.ok) throw new BatonError("E_BUDGET", "Today's voice budget is used up.", { fallback: "cached_turn_replay" });
      reservation = res.id;
    }

    let pcm: Uint8Array;
    try {
      const speak = this.d.speak ?? speakPcm;
      pcm = await speak(this.d.openai(), { input: r.text, voice: r.voice, instructions: r.instructions, model: this.model, signal: AbortSignal.timeout(this.d.timeoutMs ?? TTS_TIMEOUT_MS) });
      if (pcm.byteLength === 0 || pcm.byteLength % 2 !== 0) throw Object.assign(new Error(`TTS returned ${pcm.byteLength} bytes`), { receivedBytes: pcm.byteLength });
    } catch (e) {
      const received = (e as { receivedBytes?: number }).receivedBytes ?? 0;
      if (ledger && reservation) {
        // Audio arrived → the request was billed: settle. Nothing arrived → release.
        await (received > 0 ? ledger.settle(reservation, usd) : ledger.release(reservation)).catch((err: unknown) => ttsLog.warn("ledger close failed", { err }));
      }
      throw toBatonError(e);
    }
    if (ledger && reservation) await ledger.settle(reservation, usd).catch((err: unknown) => ttsLog.warn("ledger settle failed", { err }));

    const durationMs = pcm24kDurationMs(pcm.byteLength);
    await this.d.cache
      .put({ hash, model: this.model, voice: r.voice, text: r.text, pcm24k: pcm, durationMs })
      .catch((err: unknown) => ttsLog.warn("tts cache write failed", { err }));
    return { hash, pcm24k: pcm, durationMs, cached: false, usd };
  }
}
