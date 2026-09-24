/**
 * va-lib.ts - shared helpers for the WP5b Day-1 Voice Agent scripts (T-D1-0 … T-D1-5).
 *
 * - Every session opens through scripts/lib/aai-open.ts (limits guard, ledger, heartbeat, always session.end).
 *   The shared guard allows ONE Voice Agent session on this laptop, so `openVaQueued` waits on E_VA_CAPACITY.
 * - Events go to scripts/day1/out/<name>.jsonl (git-ignored). Audio payloads are logged as byte counts;
 *   `resume_token` is masked. No key or token is ever written.
 * - TTS customer clips (OpenAI gpt-4o-mini-tts, 24 kHz PCM16) are cached in scripts/day1/out/clips/.
 *
 * Run the scripts with `npx tsx --conditions=react-server scripts/day1/va-<test>.ts` and RUN_LIVE=1.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  RealtimeAudioFeeder, type ClientEvent, type ReplyInfo, type ServerEvent, type SessionReadyEvent, type ToolCallEvent,
  type VoiceAgentSession,
} from "../../src/core/aai/voice-agent";
import { OpenRefusedError, VA_USD_PER_SEC, openVoiceAgentNode, type VoiceAgentHandle } from "../lib/aai-open";
import { loadEnv } from "../lib/load-env";

const here = dirname(fileURLToPath(import.meta.url));
export const OUT_DIR = resolve(here, "out");
export const FIXTURES_DIR = resolve(here, "fixtures");

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
export const nowMs = () => performance.now();

export function requireLive(): void {
  loadEnv();
  if (process.env.RUN_LIVE !== "1") {
    console.error("Refusing to run: live AssemblyAI calls need RUN_LIVE=1 (TASKS §0.5).");
    process.exit(2);
  }
  if (!process.env.BATON_DEPLOY_ID) process.env.BATON_DEPLOY_ID = "dev-wp5b";
}

export function readFixture<T = { type: "session.update"; session: Record<string, unknown> }>(name: string): T {
  return JSON.parse(readFileSync(resolve(FIXTURES_DIR, name), "utf8")) as T;
}

// ------------------------------------------------------------------------------------------------ logging

export interface RunLog {
  readonly path: string;
  write(rec: Record<string, unknown>): void;
  onEvent(dir: "in" | "out", ev: ServerEvent | ClientEvent, atMs: number): void;
  /** Input audio frames sent (not logged one by one). */
  readonly inputFrames: number;
}

function redact(ev: ServerEvent | ClientEvent): Record<string, unknown> {
  const o: Record<string, unknown> = { ...(ev as Record<string, unknown>) };
  if (o.type === "reply.audio" && typeof o.data === "string") o.data = { bytes: Math.floor((o.data.length * 3) / 4) };
  if (o.type === "input.audio" && typeof o.audio === "string") o.audio = { bytes: Math.floor((o.audio.length * 3) / 4) };
  if ("resume_token" in o) o.resume_token = "***";
  if (o.type === "session.update") {
    const s = o.session as Record<string, unknown> | undefined;
    if (s && typeof s.system_prompt === "string") o.session = { ...s, system_prompt: `[${s.system_prompt.length} chars]` };
  }
  if ((o.type === "session.ready" || o.type === "session.updated") && o.config && typeof o.config === "object") {
    const c = o.config as Record<string, unknown>;
    if (typeof c.system_prompt === "string") o.config = { ...c, system_prompt: `[${c.system_prompt.length} chars]` };
  }
  return o;
}

export function makeLog(name: string): RunLog {
  mkdirSync(OUT_DIR, { recursive: true });
  const path = resolve(OUT_DIR, `${name}.jsonl`);
  writeFileSync(path, "");
  const t0 = nowMs();
  let inputFrames = 0;
  const log: RunLog = {
    path,
    write(rec) {
      appendFileSync(path, JSON.stringify({ t: Math.round(nowMs() - t0), ...rec }) + "\n");
    },
    onEvent(dir, ev, atMs) {
      if (ev.type === "input.audio") {
        inputFrames++;
        return;
      }
      if (ev.type === "reply.audio") return; // counted by ReplyTracker; too many to log
      appendFileSync(path, JSON.stringify({ t: Math.round(atMs - t0), dir, ev: redact(ev) }) + "\n");
    },
    get inputFrames() {
      return inputFrames;
    },
  };
  return log;
}

// ------------------------------------------------------------------------------------------------ opening

export interface OpenedVa {
  handle: VoiceAgentHandle;
  session: VoiceAgentSession;
  log: RunLog;
  openedAtMs: number;
  /** Queue wait for the shared VA slot. */
  waitedMs: number;
}

/**
 * Open a Voice Agent session through aai-open, waiting for the shared single VA slot (E_VA_CAPACITY) up to
 * `maxWaitMs`. Socket only: send the first session.update next.
 */
export async function openVaQueued(o: {
  name: string;
  capMs: number;
  maxWaitMs?: number;
  /** Extra raw-event hook (tests assert the order of client events on the wire). */
  onEvent?: (dir: "in" | "out", ev: ServerEvent | ClientEvent, atMs: number) => void;
}): Promise<OpenedVa> {
  const log = makeLog(o.name);
  const t0 = nowMs();
  const deadline = Date.now() + (o.maxWaitMs ?? 15 * 60_000);
  let lastMsg = "";
  for (;;) {
    try {
      const handle = await openVoiceAgentNode({
        capMs: o.capMs,
        label: `wp5b_${o.name}`,
        source: "script",
        connect: {
          onEvent: (d, ev, at) => {
            log.onEvent(d, ev, at);
            o.onEvent?.(d, ev, at);
          },
        },
      });
      const waitedMs = Math.round(nowMs() - t0);
      log.write({ note: "opened", liveSessionId: handle.liveSessionId, waitedMs });
      return { handle, session: handle.session, log, openedAtMs: nowMs(), waitedMs };
    } catch (e) {
      if (e instanceof OpenRefusedError && e.code === "E_VA_CAPACITY" && Date.now() < deadline) {
        if (e.message !== lastMsg) console.log(`[${o.name}] VA slot busy, queueing: ${e.message}`);
        lastMsg = e.message;
        await sleep(5000);
        continue;
      }
      throw e;
    }
  }
}

export async function closeVa(v: OpenedVa, reason = "done"): Promise<{ sessionSeconds: number | null; usd: number | null }> {
  await v.handle.close(reason);
  const secs = v.session.ended?.session_duration_seconds ?? null;
  const usd = secs !== null ? Math.round(secs * VA_USD_PER_SEC * 10000) / 10000 : null;
  v.log.write({ note: "closed", sessionId: v.session.sessionId, sessionSeconds: secs, usd, closed: v.session.closed ?? null });
  return { sessionSeconds: secs, usd };
}

// ------------------------------------------------------------------------------------------------ audio

/** Start real-time silence (a "mic") right after session.ready, like the product feeder. */
export function startFeeder(s: VoiceAgentSession): RealtimeAudioFeeder {
  const f = new RealtimeAudioFeeder(s);
  f.start();
  return f;
}

export interface Clip {
  id: string;
  text: string;
  pcm: Uint8Array;
  ms: number;
}

/** OpenAI TTS clip, cached on disk (24 kHz PCM16 mono). */
export async function ttsClip(id: string, text: string, voice = "marin"): Promise<Clip> {
  const dir = resolve(OUT_DIR, "clips");
  mkdirSync(dir, { recursive: true });
  const path = resolve(dir, `${id}.pcm`);
  const meta = resolve(dir, `${id}.txt`);
  if (existsSync(path) && existsSync(meta) && readFileSync(meta, "utf8") === `${voice}|${text}`) {
    const pcm = new Uint8Array(readFileSync(path));
    return { id, text, pcm, ms: pcm.length / 48 };
  }
  loadEnv();
  const key = process.env.OPENAI_API_KEY?.trim();
  if (!key) throw new Error("OPENAI_API_KEY missing (value never printed)");
  const { createOpenAI, openSpeechPcmStream } = await import("../../src/server/openai/client");
  const client = createOpenAI(key);
  const { chunks } = await openSpeechPcmStream(client, {
    input: text,
    voice,
    instructions: "A customer on a phone call. Natural, clear, moderately paced American English.",
  });
  const parts: Uint8Array[] = [];
  for await (const c of chunks) parts.push(c.pcm);
  const total = parts.reduce((n, p) => n + p.length, 0);
  const pcm = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    pcm.set(p, off);
    off += p.length;
  }
  writeFileSync(path, pcm);
  writeFileSync(meta, `${voice}|${text}`);
  return { id, text, pcm, ms: pcm.length / 48 };
}

/** Last voiced sample offset (ms) of a PCM16 clip: RMS of 10 ms windows > -45 dBFS. */
export function voicedEndMs(pcm: Uint8Array): number {
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const win = 240;
  let last = 0;
  for (let i = 0; i + win * 2 <= pcm.length; i += win * 2) {
    let acc = 0;
    for (let j = 0; j < win; j++) {
      const v = view.getInt16(i + j * 2, true);
      acc += v * v;
    }
    const db = 20 * Math.log10(Math.sqrt(acc / win) / 32768 || 1e-9);
    if (db > -45) last = (i + win * 2) / 48;
  }
  return last;
}

// ------------------------------------------------------------------------------------------------ waiting

/**
 * ReplyTracker has a single `onReplyDone` slot; chaining waiters through it breaks when they resolve out of order
 * (found in the first T-D1-1/2 run). Multiplex it once per session instead.
 */
const replyDoneListeners = new WeakMap<VoiceAgentSession, Set<(r: ReplyInfo) => void>>();
export function onReplyDone(s: VoiceAgentSession, fn: (r: ReplyInfo) => void): () => void {
  let set = replyDoneListeners.get(s);
  if (!set) {
    const listeners = new Set<(r: ReplyInfo) => void>();
    set = listeners;
    replyDoneListeners.set(s, listeners);
    s.replies.onReplyDone = (r) => {
      for (const l of [...listeners]) l(r);
    };
  }
  set.add(fn);
  return () => set.delete(fn);
}

export function waitReplyDone(s: VoiceAgentSession, timeoutMs: number, pred: (r: ReplyInfo) => boolean = () => true): Promise<ReplyInfo | null> {
  return new Promise((resolveP) => {
    const off = onReplyDone(s, (r) => {
      if (!pred(r)) return;
      clearTimeout(t);
      off();
      resolveP(r);
    });
    const t = setTimeout(() => {
      off();
      resolveP(null);
    }, timeoutMs);
  });
}

export function waitToolCall(s: VoiceAgentSession, timeoutMs: number, name?: string): Promise<ToolCallEvent | null> {
  return s
    .waitFor("tool.call", { timeoutMs, ...(name ? { pred: (e) => e.name === name } : {}) })
    .then((e) => e as ToolCallEvent)
    .catch(() => null);
}

// ------------------------------------------------------------------------------------------------ config diff

const get = (o: unknown, path: string): unknown =>
  path.split(".").reduce<unknown>((acc, k) => (acc && typeof acc === "object" ? (acc as Record<string, unknown>)[k] : undefined), o);

/** Compare what was sent against session.ready/session.updated `config` for the T-D1-0 keys. */
export function diffEcho(sent: Record<string, unknown>, ready: SessionReadyEvent | { config?: Record<string, unknown> } | undefined): {
  ok: boolean;
  checks: { key: string; sent: unknown; echoed: unknown; ok: boolean }[];
} {
  const cfg = ready?.config ?? {};
  const checks: { key: string; sent: unknown; echoed: unknown; ok: boolean }[] = [];
  const cmp = (key: string, a: unknown, b: unknown) => checks.push({ key, sent: a, echoed: b, ok: JSON.stringify(a) === JSON.stringify(b) });
  cmp("input.transcription_mode", get(sent, "input.transcription_mode") ?? null, get(cfg, "input.transcription_mode") ?? null);
  if (get(sent, "input.keyterms") !== undefined) cmp("input.keyterms", get(sent, "input.keyterms"), get(cfg, "input.keyterms"));
  cmp("output.voice", get(sent, "output.voice"), get(cfg, "output.voice"));
  cmp("greeting", get(sent, "greeting"), get(cfg, "greeting"));
  const st = (get(sent, "tools") as { name: string; execution_mode?: string; timeout_seconds?: number }[] | undefined) ?? [];
  const et = (get(cfg, "tools") as { name: string; execution_mode?: string; timeout_seconds?: number }[] | undefined) ?? [];
  cmp("tools[].name", st.map((t) => t.name), et.map((t) => t.name));
  cmp("tools[].execution_mode", st.map((t) => t.execution_mode), et.map((t) => t.execution_mode));
  cmp("tools[].timeout_seconds", st.map((t) => t.timeout_seconds), et.map((t) => t.timeout_seconds));
  return { ok: checks.every((c) => c.ok), checks };
}

/** Collapse word deltas the way captions do (spacing varies: greeting words have no trailing space). */
export function joinWords(words: { text: string }[]): string {
  return words
    .map((w) => w.text)
    .reduce((acc, w) => (acc === "" ? w.trim() : /\s$/.test(acc) || /^\s/.test(w) ? acc + w : `${acc} ${w}`), "")
    .replace(/\s+/g, " ")
    .trim();
}

export const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9$]+/g, " ").trim();

export function writeResult(name: string, result: unknown): string {
  mkdirSync(OUT_DIR, { recursive: true });
  const path = resolve(OUT_DIR, `${name}.result.json`);
  writeFileSync(path, JSON.stringify(result, null, 2) + "\n");
  return path;
}
