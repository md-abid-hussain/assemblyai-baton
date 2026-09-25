/**
 * scenario/stt-run.ts - the STT cache runner loop (DESIGN §6.2), over injected sessions and clock so it is testable
 * without a network. `scripts/eval/cache-stt.ts` binds it to `scripts/lib/aai-open.ts` (the limits authority).
 *
 * - Audio: the take's µ-law bytes (identical to Watch mode), paced at `speed`× real time in `frameMs` frames (the
 *   browser's FrameBatcher framing: 100 ms at 8 kHz), then `tailSilenceMs` of µ-law silence so the last turn
 *   finalizes (§5.1.8), then Terminate.
 * - Every server message is recorded as an `SttCacheRecord` with `recvMs` = audio ms sent to THAT session so far
 *   (= call ms: every cached session starts at call ms 0). `Begin` is recorded at 0.
 * - `pc_ctx` (ctxCarry "last_rep_turn", §5.2): on every NEW rep final, `customer.updateConfiguration({agent_context})`.
 * - A per-channel `BatonCacheMeta` trailer closes the file (params hash, billed seconds). A cache without trailers
 *   is incomplete and is never used.
 */
import type { SttCacheRecord, SttVariant } from "../contracts/eval";
import { STT_CACHE_META_TYPE, type SttCacheMeta } from "../contracts/ext/wp9-data";
import { sha256Hex } from "../case/sha256";
import type { CacheChannel } from "./stt-cache";

export const RUNNER_VERSION = "wp9-stt-run/1";
export const DEFAULT_TAIL_SILENCE_MS = 1500;

export interface RunnerSession {
  on(type: "message", fn: (m: Record<string, unknown>) => void): () => void;
  sendAudio(frame: Uint8Array): boolean;
  updateConfiguration(patch: { agent_context?: string }): boolean;
  readonly begin?: { id: string; type?: string } & Record<string, unknown>;
}

export interface OpenedChannel {
  session: RunnerSession;
  /** Terminate (idempotent) and resolve with the Termination message, if any. */
  close(): Promise<{ session_duration_seconds?: number } | null>;
  /** The exact params this session was opened with (hashed into the trailer). */
  params: Record<string, unknown>;
}

export type OpenedSessions = Partial<Record<CacheChannel, OpenedChannel>>;

export interface SttRunInput {
  callId: string;
  variant: SttVariant;
  /** µ-law 8 kHz: rep + customer for per-channel variants, mono for mono_diar. */
  audio: { rep: Uint8Array; customer: Uint8Array } | { mono: Uint8Array };
  ctxCarry: "none" | "last_rep_turn";
  sampleRate?: number;
  bytesPerSample?: number;
  silenceByte?: number;
  frameMs?: number;
  tailSilenceMs?: number;
  speed?: number;
}

export interface SttRunDeps {
  /** Opens the sessions this variant needs (rep+customer as ONE grant, or mono) through the limits authority. */
  open(): Promise<OpenedSessions>;
  now(): number;
  sleep(ms: number): Promise<void>;
  /** ISO timestamp for the trailer. */
  isoNow(): string;
  onProgress?: (p: { sentMs: number; totalMs: number }) => void;
}

export interface SttRunResult {
  records: SttCacheRecord[];
  meta: Partial<Record<CacheChannel, SttCacheMeta>>;
  audioMs: number;
  agentContextUpdates: number;
}

const sortKeys = (v: unknown): unknown => {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]));
  return v;
};

/** sha256(JSON of the exact params, keys sorted).slice(0, 16). */
export const paramsHashOf = (params: Record<string, unknown>): string => sha256Hex(JSON.stringify(sortKeys(params))).slice(0, 16);

const isNewFinal = (m: Record<string, unknown>, seen: Set<number>): string | null => {
  if (m["type"] !== "Turn" || m["end_of_turn"] !== true || typeof m["turn_order"] !== "number") return null;
  const text = typeof m["transcript"] === "string" ? m["transcript"].trim() : "";
  if (!text || seen.has(m["turn_order"])) return null;
  seen.add(m["turn_order"]);
  return text;
};

export class SttRunError extends Error {
  constructor(message: string, readonly partial: SttCacheRecord[]) {
    super(message);
    this.name = "SttRunError";
  }
}

export async function runSttCache(i: SttRunInput, deps: SttRunDeps): Promise<SttRunResult> {
  const rate = i.sampleRate ?? 8000;
  const bps = i.bytesPerSample ?? 1;
  const silence = i.silenceByte ?? 0xff;
  const frameMs = i.frameMs ?? 100;
  const speed = i.speed ?? 1;
  const tailMs = i.tailSilenceMs ?? DEFAULT_TAIL_SILENCE_MS;
  const frameBytes = Math.round((rate * frameMs) / 1000) * bps;
  const bytesPerMs = (rate * bps) / 1000;

  const channels: CacheChannel[] = "mono" in i.audio ? ["mono"] : ["rep", "customer"];
  const src: Partial<Record<CacheChannel, Uint8Array>> = "mono" in i.audio ? { mono: i.audio.mono } : { rep: i.audio.rep, customer: i.audio.customer };
  const audioBytes = Math.max(...channels.map((c) => src[c]!.byteLength));
  const tailBytes = Math.round(tailMs * bytesPerMs);
  const totalBytes = audioBytes + tailBytes;
  const totalMs = totalBytes / bytesPerMs;

  const sessions = await deps.open();
  for (const c of channels) if (!sessions[c]) throw new Error(`runSttCache: no ${c} session opened for ${i.variant}`);

  const records: SttCacheRecord[] = [];
  const sentMs: Record<string, number> = Object.fromEntries(channels.map((c) => [c, 0]));
  const repFinals = new Set<number>();
  let ctxUpdates = 0;
  const unsub: (() => void)[] = [];
  let closedEarly: string | null = null;

  for (const c of channels) {
    const s = sessions[c]!.session;
    if (s.begin) records.push({ callId: i.callId, variant: i.variant, channel: c, recvMs: 0, message: { ...s.begin } });
    unsub.push(
      s.on("message", (m) => {
        records.push({ callId: i.callId, variant: i.variant, channel: c, recvMs: sentMs[c]!, message: m });
        if (c === "rep" && i.ctxCarry === "last_rep_turn") {
          const text = isNewFinal(m, repFinals);
          if (text && sessions.customer?.session.updateConfiguration({ agent_context: text })) ctxUpdates++;
        }
      }),
    );
  }

  const t0 = deps.now();
  try {
    for (let off = 0; off < totalBytes; off += frameBytes) {
      const len = Math.min(frameBytes, totalBytes - off);
      const ms = len / bytesPerMs;
      const due = t0 + ((off + len) / bytesPerMs) / speed;
      const wait = due - deps.now();
      if (wait > 1) await deps.sleep(wait);
      for (const c of channels) {
        const bytes = src[c]!;
        // The last frame may be short: pad it to a full frame of silence (never < 50 ms: close 3007).
        const frame = new Uint8Array(Math.max(len, Math.round(50 * bytesPerMs))).fill(silence);
        if (off < bytes.byteLength) frame.set(bytes.subarray(off, Math.min(off + len, bytes.byteLength)));
        // Count the frame before sending: anything the server answers from now on has "heard" it.
        const before = sentMs[c]!;
        sentMs[c] = before + Math.max(ms, 50);
        if (!sessions[c]!.session.sendAudio(frame)) {
          sentMs[c] = before;
          closedEarly = `${c} session closed at ${Math.round(before)} ms`;
          break;
        }
      }
      if (closedEarly) break;
      deps.onProgress?.({ sentMs: sentMs[channels[0]!]!, totalMs });
    }
  } finally {
    // Always terminate (the handles also report + settle through the limits authority).
    const terms = await Promise.all(channels.map(async (c) => [c, await sessions[c]!.close().catch(() => null)] as const));
    for (const u of unsub) u();
    if (!closedEarly) {
      const iso = deps.isoNow();
      for (const [c, term] of terms) {
        const opened = sessions[c]!;
        const meta: SttCacheMeta = {
          type: STT_CACHE_META_TYPE,
          paramsHash: paramsHashOf(opened.params),
          params: opened.params,
          transcribedAt: iso,
          billedSeconds: typeof term?.session_duration_seconds === "number" ? term.session_duration_seconds : null,
          audioMsSent: sentMs[c]!,
          providerSessionId: typeof opened.session.begin?.id === "string" ? opened.session.begin.id : null,
          agentContextUpdates: c === "customer" ? ctxUpdates : 0,
          closeCode: null,
          runner: RUNNER_VERSION,
        };
        records.push({ callId: i.callId, variant: i.variant, channel: c, recvMs: sentMs[c]!, message: meta as unknown as Record<string, unknown> });
      }
    }
  }
  if (closedEarly) throw new SttRunError(`${i.callId} ${i.variant}: ${closedEarly}; cache not written`, records);

  const meta: Partial<Record<CacheChannel, SttCacheMeta>> = {};
  for (const r of records) if (r.message["type"] === STT_CACHE_META_TYPE) meta[r.channel] = r.message as unknown as SttCacheMeta;
  return { records, meta, audioMs: sentMs[channels[0]!]!, agentContextUpdates: ctxUpdates };
}

/** µ-law mono downmix for `mono_diar` (§6.2): decode both channels, average, re-encode. */
export function downmixUlaw(rep: Uint8Array, customer: Uint8Array, decode: (b: number) => number, encode: (s: number) => number): Uint8Array {
  const n = Math.max(rep.byteLength, customer.byteLength);
  const out = new Uint8Array(n);
  for (let k = 0; k < n; k++) {
    const a = k < rep.byteLength ? decode(rep[k]!) : 0;
    const b = k < customer.byteLength ? decode(customer[k]!) : 0;
    out[k] = encode(Math.max(-32768, Math.min(32767, Math.round((a + b) / 2))));
  }
  return out;
}

/** Estimated USD for one call × variant at list prices (§6.2; prompt adds $0.05/h, diarization $0.12/h). */
export function estimateSttUsd(variant: SttVariant, audioMs: number, tailMs = DEFAULT_TAIL_SILENCE_MS): number {
  const h = (audioMs + tailMs) / 3_600_000;
  return variant === "mono_diar" ? h * (0.45 + 0.12 + 0.05) : 2 * h * (0.45 + 0.05);
}
