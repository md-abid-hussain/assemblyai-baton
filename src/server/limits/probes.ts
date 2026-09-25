import "server-only";

import { StreamingSession, streamAudioPaced, type StreamingParams, type TurnMessage } from "../../core/aai/streaming";
import type { LimitsAuthority } from "../../core/contracts/services";
import { mintSttToken, mintVaToken } from "../aai/tokens";
import { connectNode, nodeWebSocketFactory } from "../aai/va-node";
import { STT_USD_PER_SEC, VA_USD_PER_SEC } from "./config";

/**
 * Synthetic-check probes that talk to AssemblyAI (DESIGN §4.5 F7). They live under src/server/limits/** because
 * this is one of the few places allowed to mint and open (tests/unit/boundaries.test.ts); every open goes through
 * the limits authority (source "synthetic"), reserves and settles its ledger entry, and always Terminates /
 * `session.end`s.
 *
 *  light: mint an STT token and a VA token (no connect, $0).
 *  full:  one STT session streaming a ~4-7 s fixture (expects "481529" in a final), and one VA session with a
 *         greeting-only config until the first audible chunk, then `session.end` (≈ $0.0075 in total).
 */

export interface ProbeResult {
  ok: boolean;
  ms: number;
  code?: string;
  detail?: string;
  [extra: string]: unknown;
}

const since = (t0: number): number => Math.round(performance.now() - t0);
const codeOf = (e: unknown): string =>
  e && typeof e === "object" && "code" in e && typeof (e as { code: unknown }).code === "string" ? (e as { code: string }).code : "E_PROBE";
const msgOf = (e: unknown): string => (e instanceof Error ? e.message : String(e)).slice(0, 200);

export async function probeMintStt(): Promise<ProbeResult> {
  const t0 = performance.now();
  try {
    const t = await mintSttToken();
    return { ok: t.token.length > 20, ms: since(t0) };
  } catch (e) {
    return { ok: false, ms: since(t0), code: codeOf(e), detail: msgOf(e) };
  }
}

export async function probeMintVa(): Promise<ProbeResult> {
  const t0 = performance.now();
  try {
    const t = await mintVaToken({ maxSessionDurationSeconds: 60 });
    return { ok: t.token.length > 20, ms: since(t0) };
  } catch (e) {
    return { ok: false, ms: since(t0), code: codeOf(e), detail: msgOf(e) };
  }
}

async function acquireOneStt(a: LimitsAuthority, deployId: string, maxWaitMs = 20_000): Promise<string> {
  const deadline = Date.now() + maxWaitMs;
  let ticket: string | undefined;
  for (;;) {
    const r = await a.sttAcquire({ n: 1, visitorId: "synthetic", ipKey: "synthetic", source: "synthetic", deployId, ...(ticket ? { ticket } : {}) });
    if (r.status === "granted") return r.sessionIds[0]!;
    if (r.status === "denied") throw Object.assign(new Error(r.message), { code: r.code });
    ticket = r.ticket;
    if (Date.now() + 2000 > deadline) {
      await a.sttCancel(r.ticket).catch(() => undefined);
      throw Object.assign(new Error("still queued"), { code: "E_QUEUE_TIMEOUT" });
    }
    await new Promise((res) => setTimeout(res, 2000));
  }
}

/** Full STT probe: stream `pcm16k` (s16le mono 16 kHz) through one live session; pass when a final contains `expectDigits`. */
export async function probeFullStt(a: LimitsAuthority, o: { pcm16k: Uint8Array; expectDigits: string; deployId: string }): Promise<ProbeResult & { transcript?: string; billedSeconds?: number }> {
  const t0 = performance.now();
  let sessionId: string | null = null;
  let ledgerId: string | null = null;
  let session: StreamingSession | null = null;
  try {
    sessionId = await acquireOneStt(a, o.deployId);
    const audioS = o.pcm16k.byteLength / 32_000;
    const res = await a.ledger.reserve({ provider: "aai_stt", action: "synthetic_full", refId: sessionId, estUsd: (audioS + 35) * STT_USD_PER_SEC, env: o.deployId });
    if (!res.ok) throw Object.assign(new Error("ledger refused"), { code: res.code });
    ledgerId = res.id;
    const { token } = await mintSttToken({ maxSessionDurationSeconds: 60 });
    const params: StreamingParams = { speech_model: "universal-3-5-pro", encoding: "pcm_s16le", sample_rate: 16_000, mode: "min_latency", inactivity_timeout: 30 } as StreamingParams;
    session = await StreamingSession.connect({ auth: { token }, params, factory: nodeWebSocketFactory, connectTimeoutMs: 8000 });
    await a.report({ sessionId, kind: "stt", event: "opened", providerSessionId: session.begin.id });
    const finals: string[] = [];
    session.on("turn", (t: TurnMessage) => {
      if (t.end_of_turn && t.transcript) finals.push(t.transcript);
    });
    await streamAudioPaced(session, o.pcm16k, { sampleRate: 16_000, tailSilenceMs: 1500 });
    const term = await session.terminate({ timeoutMs: 5000 });
    const billed = term?.session_duration_seconds;
    await a.report({ sessionId, kind: "stt", event: "closed", providerSessionId: session.begin.id, ...(billed !== undefined ? { billedSeconds: billed } : {}) });
    if (billed !== undefined && ledgerId) await a.ledger.settle(ledgerId, billed * STT_USD_PER_SEC);
    const transcript = finals.join(" ");
    const ok = transcript.replace(/\D/g, "").includes(o.expectDigits);
    return { ok, ms: since(t0), ...(ok ? {} : { code: "E_PROBE_TRANSCRIPT" }), transcript: transcript.slice(0, 200), ...(billed !== undefined ? { billedSeconds: billed } : {}) };
  } catch (e) {
    if (session && !session.closeInfo) await session.terminate({ timeoutMs: 3000 }).catch(() => null);
    if (sessionId) {
      await a.report({ sessionId, kind: "stt", event: "closed", ...(session ? { providerSessionId: session.begin?.id } : {}) }).catch(() => undefined);
      if (!session) await a.release(sessionId, "synthetic_failed").catch(() => undefined);
    }
    return { ok: false, ms: since(t0), code: codeOf(e), detail: msgOf(e) };
  }
}

/** Full VA probe: greeting-only session until the first audio chunk, then `session.end`. */
export async function probeFullVa(a: LimitsAuthority, o: { deployId: string; voice: string }): Promise<ProbeResult & { firstAudioMs?: number; billedSeconds?: number }> {
  const t0 = performance.now();
  let liveSessionId: string | null = null;
  let ledgerId: string | null = null;
  let session: Awaited<ReturnType<typeof connectNode>> | null = null;
  try {
    const slot = await a.vaAcquire({ attempt: 0, capMs: 60_000, source: "synthetic", deployId: o.deployId });
    if (!slot.ok) throw Object.assign(new Error(slot.message), { code: slot.code });
    liveSessionId = slot.liveSessionId;
    const res = await a.ledger.reserve({ provider: "aai_va", action: "synthetic_full", refId: liveSessionId, estUsd: 45 * VA_USD_PER_SEC, env: o.deployId });
    if (!res.ok) throw Object.assign(new Error("ledger refused"), { code: res.code });
    ledgerId = res.id;
    const { token } = await mintVaToken({ maxSessionDurationSeconds: 60 });
    session = await connectNode({ token, openTimeoutMs: 8000 });
    const firstAudio = session.waitFor("reply.audio", { timeoutMs: 10_000 });
    const ready = await session.start({ system_prompt: "You are a health check. Say only the greeting, then stop.", greeting: "Health check.", output: { voice: o.voice } }, 8000);
    await a.report({ sessionId: liveSessionId, kind: "va", event: "opened", providerSessionId: ready.session_id });
    const tReady = performance.now();
    await firstAudio;
    const firstAudioMs = Math.round(performance.now() - tReady);
    const ended = await session.end(5000);
    const billed = ended?.session_duration_seconds;
    await a.report({ sessionId: liveSessionId, kind: "va", event: "closed", providerSessionId: ready.session_id, ...(billed !== undefined ? { billedSeconds: billed } : {}) });
    if (billed !== undefined && ledgerId) await a.ledger.settle(ledgerId, billed * VA_USD_PER_SEC);
    return { ok: true, ms: since(t0), firstAudioMs, ...(billed !== undefined ? { billedSeconds: billed } : {}) };
  } catch (e) {
    if (session) await session.end(3000).catch(() => undefined);
    if (liveSessionId) await a.report({ sessionId: liveSessionId, kind: "va", event: "closed" }).catch(() => undefined);
    return { ok: false, ms: since(t0), code: codeOf(e), detail: msgOf(e) };
  }
}
