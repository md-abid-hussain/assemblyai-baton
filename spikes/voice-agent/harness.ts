/**
 * harness.ts - spike-only glue between client.ts and the shared lib (logger, env, fixtures).
 * Logs go to spikes/out/va-<test>.jsonl. Audio payloads are summarised as {bytes}; input.audio frames
 * are tallied (one summary line) instead of logged one per 50 ms.
 */
import { resolve } from "node:path";
import { ASSEMBLYAI_API_KEY, FIXTURES_DIR, OUT_DIR } from "../lib/env.ts";
import { createLogger, type JsonlLogger } from "../lib/log.ts";
import { readWav } from "../lib/wav.ts";
import { bytesToPcm16, pcm16ToBytes, rmsDbfs, trimSilence } from "../lib/audio.ts";
import {
  VoiceAgentRest,
  connectNode,
  type AuthStyle,
  type ClientEvent,
  type NodeConnectOptions,
  type ServerEvent,
  type VoiceAgentSession,
  base64ToBytes,
} from "./client.ts";

export { OUT_DIR, FIXTURES_DIR, ASSEMBLYAI_API_KEY };

export function vaLogger(test: string): JsonlLogger {
  return createLogger(`va-${test}`, { echo: false, maxString: 3000 });
}

export function restFor(log: JsonlLogger, authStyle: AuthStyle = "raw", base?: string): VoiceAgentRest {
  return new VoiceAgentRest(ASSEMBLYAI_API_KEY, {
    authStyle,
    ...(base ? { base } : {}),
    onHttp: (t) => log.event("http", { label: t.label, method: t.method, url: t.url, status: t.status, ms: t.ms, request: t.requestBody, response: t.responseBody }),
  });
}

export interface Recorder {
  /** First-receive time (ms since logger start) per event type. */
  first: Map<string, number>;
  /** Every event with logger-relative time. */
  events: { ms: number; ev: ServerEvent }[];
  /** reply.audio bytes grouped by reply_id (or "?" when absent). */
  audioByReply: Map<string, Uint8Array[]>;
  /** Order of reply ids as seen in reply.started. */
  replyOrder: string[];
  currentReplyId: string | undefined;
  /** Every reply.audio chunk: arrival (logger ms), reply id, byte length, RMS level in dBFS. */
  audioChunks: { ms: number; replyId: string; bytes: number; rmsDb: number }[];
}

/** Wire a session's raw events into the JSONL log and an in-memory recorder. */
export function onEventLogger(log: JsonlLogger, rec?: Recorder): NodeConnectOptions["onEvent"] {
  let inputAudioLogged = 0;
  return (dir, ev) => {
    if (dir === "out") {
      const ce = ev as ClientEvent;
      if (ce.type === "input.audio") {
        const bytes = Math.floor((ce.audio.length * 3) / 4);
        log.tally("out input.audio", bytes);
        if (inputAudioLogged++ < 1) log.out(ce, { note: "first input.audio frame (later frames tallied)" });
        return;
      }
      log.out(ce);
      return;
    }
    const se = ev as ServerEvent;
    const ms = log.elapsed();
    if (rec) {
      if (!rec.first.has(se.type)) rec.first.set(se.type, ms);
      rec.events.push({ ms, ev: se.type === "reply.audio" ? ({ ...se, data: `<${(se as { data?: string }).data?.length ?? 0} b64 chars>` } as ServerEvent) : se });
      if (se.type === "reply.started") {
        const id = String((se as { reply_id?: unknown }).reply_id ?? "?");
        rec.currentReplyId = id;
        rec.replyOrder.push(id);
      }
      if (se.type === "reply.audio") {
        const id = String((se as { reply_id?: unknown }).reply_id ?? rec.currentReplyId ?? "?");
        const data = (se as { data?: string }).data;
        if (data) {
          const bytes = base64ToBytes(data);
          const arr = rec.audioByReply.get(id) ?? [];
          arr.push(bytes);
          rec.audioByReply.set(id, arr);
          rec.audioChunks.push({ ms, replyId: id, bytes: bytes.length, rmsDb: Math.round(rmsDbfs(bytesToPcm16(bytes)) * 10) / 10 });
        }
      }
    }
    log.in(maskResumeToken(se));
  };
}

/** session.ready carries a resume_token (a signed session credential) - never write it to logs verbatim. */
export function maskResumeToken<T>(ev: T): T {
  const e = ev as { resume_token?: unknown };
  if (e && typeof e === "object" && typeof e.resume_token === "string") {
    return { ...ev, resume_token: `<masked ${e.resume_token.length} chars>` } as T;
  }
  return ev;
}

export const newRecorder = (): Recorder => ({ first: new Map(), events: [], audioByReply: new Map(), replyOrder: [], currentReplyId: undefined, audioChunks: [] });

/** Arrival time (logger ms) of the first reply.audio chunk after `afterMs` whose level is above `thresholdDb` (audible, not padding). */
export function firstAudibleAfter(rec: Recorder, afterMs: number, thresholdDb = -50): number | undefined {
  return rec.audioChunks.find((c) => c.ms >= afterMs && c.rmsDb > thresholdDb)?.ms;
}

/** Leading silent audio (ms of audio) at the start of each reply. */
export function leadingSilenceByReply(rec: Recorder, thresholdDb = -50): Record<string, number> {
  const out: Record<string, number> = {};
  for (const id of rec.replyOrder) {
    const chunks = rec.audioChunks.filter((c) => c.replyId === id);
    let ms = 0;
    for (const c of chunks) {
      if (c.rmsDb > thresholdDb) break;
      ms += c.bytes / 48;
    }
    out[id] = Math.round(ms);
  }
  return out;
}

export async function open(log: JsonlLogger, o: Omit<NodeConnectOptions, "onEvent">, rec?: Recorder): Promise<VoiceAgentSession> {
  log.note("connect", { url: o.url ?? "wss://agents.assemblyai.com/v1/ws", via: o.token ? "token query param" : o.apiKey ? `Authorization header (${o.authStyle ?? "raw"})` : "no auth" });
  const t = log.elapsed();
  const s = await connectNode({ ...o, onEvent: onEventLogger(log, rec) });
  log.note("socket open", { openMs: Math.round(log.elapsed() - t) });
  s.ws.addEventListener("close", (c) => log.note("socket close", { code: c.code, reason: String(c.reason ?? "") }));
  return s;
}

/** Fixture -> raw PCM16 bytes (asserts sample rate) + detected speech bounds. */
export function loadFixturePcm(name: string, expectRate = 24000): { bytes: Uint8Array; durationMs: number; speechStartMs: number; speechEndMs: number } {
  const w = readWav(resolve(FIXTURES_DIR, name));
  if (w.sampleRate !== expectRate || w.channels !== 1) throw new Error(`${name}: expected ${expectRate} Hz mono, got ${w.sampleRate} Hz x${w.channels}`);
  const t = trimSilence(w.samples, w.sampleRate, { thresholdDb: -45, padMs: 0 });
  return {
    bytes: new Uint8Array(pcm16ToBytes(w.samples)),
    durationMs: w.durationMs,
    speechStartMs: Math.round((t.start / w.sampleRate) * 1000),
    speechEndMs: Math.round((t.end / w.sampleRate) * 1000),
  };
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export function concatBytes(parts: Uint8Array[]): Uint8Array {
  const n = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(n);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

export interface TurnMetrics {
  label: string;
  sentAtMs: number;
  replyStartedMs: number | null;
  firstAudioMs: number | null;
  /** First reply.audio chunk above -50 dBFS (the server pads replies with leading silence). */
  firstAudibleMs: number | null;
  toolCalls: { name: string; arguments: unknown; atMs: number }[];
  replyDones: { reply_id?: string; status?: string; atMs: number }[];
  agentText: string[];
  errors: unknown[];
  eventTypes: string[];
  settled: boolean;
}

/**
 * Wait for the agent's reply chain after `trigger()` (tool round trips included) to settle: at least one
 * reply.done, no tool call without a sent result, and `quietMs` without a new reply.started.
 * Times are ms relative to the trigger.
 */
export async function awaitTurn(s: VoiceAgentSession, rec: Recorder, log: JsonlLogger, label: string, trigger: () => void, o: { timeoutMs?: number; quietMs?: number; expectReply?: boolean } = {}): Promise<TurnMetrics> {
  const idx = rec.events.length;
  const toolIdx = s.tools.traces.length;
  const t0 = log.elapsed();
  log.note(`turn: ${label}`);
  trigger();
  const timeout = o.timeoutMs ?? 30000;
  const quiet = o.quietMs ?? 1500;
  const deadline = Date.now() + timeout;
  let settled = false;
  while (Date.now() < deadline && s.isOpen) {
    await sleep(100);
    const evs = rec.events.slice(idx);
    const dones = evs.filter((e) => e.ev.type === "reply.done");
    const traces = s.tools.traces.slice(toolIdx);
    const toolsOpen = traces.some((t) => t.sentAtMs === undefined && !t.dropped);
    const lastStart = [...evs].reverse().find((e) => e.ev.type === "reply.started");
    const lastDone = dones[dones.length - 1];
    if (o.expectReply === false) {
      if (log.elapsed() - t0 > quiet) {
        settled = true;
        break;
      }
      continue;
    }
    if (lastDone && !toolsOpen && (!lastStart || lastStart.ms < lastDone.ms) && log.elapsed() - lastDone.ms > quiet) {
      settled = true;
      break;
    }
  }
  const evs = rec.events.slice(idx);
  const rel = (ms: number | undefined) => (ms === undefined ? null : Math.round(ms - t0));
  const m: TurnMetrics = {
    label,
    sentAtMs: Math.round(t0),
    replyStartedMs: rel(evs.find((e) => e.ev.type === "reply.started")?.ms),
    firstAudioMs: rel(evs.find((e) => e.ev.type === "reply.audio")?.ms),
    firstAudibleMs: rel(firstAudibleAfter(rec, t0)),
    toolCalls: evs.filter((e) => e.ev.type === "tool.call").map((e) => ({ name: String((e.ev as { name?: unknown }).name), arguments: (e.ev as { arguments?: unknown }).arguments, atMs: rel(e.ms)! })),
    replyDones: evs.filter((e) => e.ev.type === "reply.done").map((e) => ({ reply_id: (e.ev as { reply_id?: string }).reply_id, status: (e.ev as { status?: string }).status, atMs: rel(e.ms)! })),
    agentText: evs.filter((e) => e.ev.type === "transcript.agent").map((e) => String((e.ev as { text?: unknown }).text)),
    errors: evs.filter((e) => e.ev.type === "session.error").map((e) => e.ev),
    eventTypes: [...new Set(evs.map((e) => e.ev.type))],
    settled,
  };
  log.note(`turn result: ${label}`, m);
  return m;
}

export interface SpeechTurnMetrics {
  speechEndLogMs: number;
  /** All times below are ms relative to the end of the clip's last voiced sample. */
  finalSpeechStopped: number | null;
  firstReplyStartedAfterStop: number | null;
  firstAudioAfterStop: number | null;
  firstAudibleAfterStop: number | null;
  toolCall: number | null;
  toolResultSent: number | null;
  answerFirstAudio: number | null;
  answerFirstAudible: number | null;
  userTranscripts: string[];
  agentText: string[];
  replyDones: { status?: string; at: number }[];
  errors: unknown[];
  settled: boolean;
}

/** Play a clip through the feeder and measure the turn relative to the clip's end of speech. */
export async function speechTurn(
  s: VoiceAgentSession,
  rec: Recorder,
  log: JsonlLogger,
  feeder: { play(b: Uint8Array): Promise<{ recordStartMs: number }> },
  clip: { bytes: Uint8Array; speechEndMs: number },
  o: { timeoutMs?: number; quietMs?: number } = {},
): Promise<SpeechTurnMetrics> {
  const idx = rec.events.length;
  const toolIdx = s.tools.traces.length;
  log.note("speech turn: playing clip");
  const t = await feeder.play(clip.bytes);
  const speechEnd = t.recordStartMs - log.t0 + clip.speechEndMs;
  const deadline = Date.now() + (o.timeoutMs ?? 30000);
  const quiet = o.quietMs ?? 1500;
  let settled = false;
  while (Date.now() < deadline && s.isOpen) {
    await sleep(100);
    const evs = rec.events.slice(idx).filter((e) => e.ms > speechEnd - 300);
    const lastDone = [...evs].reverse().find((e) => e.ev.type === "reply.done");
    const lastStart = [...evs].reverse().find((e) => e.ev.type === "reply.started");
    const toolsOpen = s.tools.traces.slice(toolIdx).some((tr) => tr.sentAtMs === undefined && !tr.dropped);
    if (lastDone && (!lastStart || lastStart.ms < lastDone.ms) && !toolsOpen && log.elapsed() - lastDone.ms > quiet) {
      settled = true;
      break;
    }
  }
  const all = rec.events.slice(idx);
  const rel = (ms: number | undefined) => (ms === undefined ? null : Math.round(ms - speechEnd));
  const stop = all.find((e) => e.ev.type === "input.speech.stopped" && e.ms > speechEnd - 300);
  const after = (type: string, from: number | undefined) => (from === undefined ? undefined : all.find((e) => e.ev.type === type && e.ms >= from));
  const trace = s.tools.traces.slice(toolIdx)[0];
  const sent = trace?.sentAtMs !== undefined ? trace.sentAtMs - log.t0 : undefined;
  const m: SpeechTurnMetrics = {
    speechEndLogMs: Math.round(speechEnd),
    finalSpeechStopped: rel(stop?.ms),
    firstReplyStartedAfterStop: rel(after("reply.started", stop?.ms)?.ms),
    firstAudioAfterStop: rel(after("reply.audio", stop?.ms)?.ms),
    firstAudibleAfterStop: stop ? rel(firstAudibleAfter(rec, stop.ms)) : null,
    toolCall: rel(all.find((e) => e.ev.type === "tool.call")?.ms),
    toolResultSent: rel(sent),
    answerFirstAudio: rel(after("reply.audio", sent)?.ms),
    answerFirstAudible: sent !== undefined ? rel(firstAudibleAfter(rec, sent)) : null,
    userTranscripts: all.filter((e) => e.ev.type === "transcript.user").map((e) => String((e.ev as { text?: unknown }).text)),
    agentText: all.filter((e) => e.ev.type === "transcript.agent").map((e) => String((e.ev as { text?: unknown }).text)),
    replyDones: all.filter((e) => e.ev.type === "reply.done").map((e) => ({ status: (e.ev as { status?: string }).status, at: rel(e.ms)! })),
    errors: all.filter((e) => e.ev.type === "session.error").map((e) => e.ev),
    settled,
  };
  log.note("speech turn result", m);
  return m;
}

/** Transcribe a local WAV with OpenAI gpt-4o-transcribe (to learn what the agent actually said). */
export async function transcribeWav(path: string, log?: JsonlLogger): Promise<string> {
  const { default: OpenAI } = await import("openai");
  const { createReadStream } = await import("node:fs");
  const { OPENAI_API_KEY } = await import("../lib/env.ts");
  const client = new OpenAI({ apiKey: OPENAI_API_KEY });
  const t = performance.now();
  const r = await client.audio.transcriptions.create({ file: createReadStream(path), model: "gpt-4o-transcribe" });
  log?.event("http", { label: "openai transcribe", path, ms: Math.round(performance.now() - t), text: r.text });
  return r.text;
}

/** Truncate long strings / arrays for the markdown write-up. */
export function brief(v: unknown, max = 600): string {
  const s = JSON.stringify(v);
  return s === undefined ? "undefined" : s.length > max ? `${s.slice(0, max)}...` : s;
}
