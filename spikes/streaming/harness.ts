/**
 * harness.ts - spike-only helpers for the Streaming STT smoke tests: fixtures, a cross-process
 * session-open rate guard, a logged session runner with an audio-time action schedule, and the
 * metrics (latency vs script, rough WER, entity hits, diarization accuracy).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { ASSEMBLYAI_API_KEY, FIXTURES_DIR, OUT_DIR } from "../lib/env.ts";
import { type JsonlLogger } from "../lib/log.ts";
import { readWav, pcm16ToBytes } from "../lib/wav.ts";
import {
  type Auth,
  type BeginMessage,
  type ServerMessage,
  StreamingConnectError,
  StreamingSession,
  type StreamingParams,
  type TerminationMessage,
  type TurnMessage,
  type SpeakerRevisionMessage,
  type WebSocketFactory,
  type WebSocketLike,
  TurnTracker,
  buildStreamingUrl,
} from "./client.ts";
import WS from "ws";

/** Node `ws` package (supports headers and exposes the HTTP status of rejected upgrades). */
export const wsFactory: WebSocketFactory = (url, headers) => new WS(url, headers ? { headers } : {}) as unknown as WebSocketLike;
/** Node 22 built-in WebSocket (undici): no headers, behaves like a browser on rejected upgrades. */
export const globalFactory: WebSocketFactory = (url, headers) => {
  if (headers) throw new Error("global WebSocket cannot send headers");
  return new (globalThis as unknown as { WebSocket: new (u: string) => WebSocketLike }).WebSocket(url);
};

export const API_KEY = ASSEMBLYAI_API_KEY;

// ---------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------

export interface Fixture {
  name: string;
  bytes: Uint8Array;
  sampleRate: number;
  bytesPerSample: 1 | 2;
  durationMs: number;
}

export function loadFixture(name: string): Fixture {
  const p = resolve(FIXTURES_DIR, name);
  if (name.endsWith(".mulaw")) {
    const bytes = readFileSync(p);
    return { name, bytes, sampleRate: 8000, bytesPerSample: 1, durationMs: bytes.byteLength / 8 };
  }
  const w = readWav(p);
  if (w.channels !== 1) throw new Error(`${name}: expected mono`);
  return { name, bytes: pcm16ToBytes(w.samples), sampleRate: w.sampleRate, bytesPerSample: 2, durationMs: w.durationMs };
}

export interface ScriptTurn {
  index: number;
  speaker: "adjuster" | "claimant";
  text: string;
  start_ms: number;
  end_ms: number;
}
export const dialogScript = (): { turns: ScriptTurn[]; facts: Record<string, unknown> } =>
  JSON.parse(readFileSync(resolve(FIXTURES_DIR, "dialog_script.json"), "utf8")) as { turns: ScriptTurn[]; facts: Record<string, unknown> };

// ---------------------------------------------------------------------------------------------
// Rate guard: at most N session opens per rolling 60 s across processes (free tier = 5/min).
// ---------------------------------------------------------------------------------------------

const GUARD_FILE = resolve(OUT_DIR, "streaming-session-opens.json");
const OPEN_LIMIT = Number(process.env.STREAM_OPEN_LIMIT ?? 4);

export async function rateGuard(log?: JsonlLogger): Promise<void> {
  for (;;) {
    let opens: number[] = [];
    try {
      if (existsSync(GUARD_FILE)) opens = JSON.parse(readFileSync(GUARD_FILE, "utf8")) as number[];
    } catch {
      opens = [];
    }
    const now = Date.now();
    opens = opens.filter((t) => now - t < 60_000);
    if (opens.length < OPEN_LIMIT) {
      opens.push(now);
      writeFileSync(GUARD_FILE, JSON.stringify(opens));
      return;
    }
    const waitMs = 60_000 - (now - Math.min(...opens)) + 250;
    log?.note("rate guard: waiting before opening another session", { waitMs, opensInLastMinute: opens.length, limit: OPEN_LIMIT });
    console.log(`[rate-guard] waiting ${Math.round(waitMs / 1000)} s`);
    await sleep(waitMs);
  }
}

// ---------------------------------------------------------------------------------------------
// Session runner
// ---------------------------------------------------------------------------------------------

export interface TimedEvent {
  /** ms since streaming started (t0 = first audio frame scheduled) or since connect when no audio. */
  wallMs: number;
  msg: ServerMessage | Record<string, unknown>;
}

export interface ScheduledAction {
  atAudioMs: number;
  label: string;
  run: (s: StreamingSession) => void;
}

export interface RunOptions {
  log: JsonlLogger;
  params: StreamingParams | Record<string, unknown>;
  auth?: Auth;
  baseUrl?: string;
  fixture?: Fixture;
  chunkMs?: number;
  speed?: number;
  schedule?: ScheduledAction[];
  /** Stop sending audio when an Error arrives (default true). */
  stopOnError?: boolean;
  /** After the last audio frame, wait this long before Terminate (default 1500 ms). */
  tailMs?: number;
  /** Idle wait after Begin when there is no audio (default 0). */
  idleMs?: number;
  /** Skip Terminate (for tests where the server is expected to close). */
  noTerminate?: boolean;
  skipRateGuard?: boolean;
  /** Custom per-frame sender (error tests); default sends fixture frames paced. */
  customSend?: (s: StreamingSession, t0: number) => Promise<void>;
  connectTimeoutMs?: number;
  /** Force a WebSocket implementation ("ws" = Node ws package, "global" = Node 22 built-in / browser-like). */
  impl?: "ws" | "global";
}

export interface RunResult {
  ok: boolean;
  url: string;
  connectMs?: number;
  begin?: BeginMessage;
  connectError?: StreamingConnectError["details"] & { message: string };
  events: TimedEvent[];
  turns: TimedEvent[];
  finals: { wallMs: number; turn: TurnMessage }[];
  tracker: TurnTracker;
  termination: TerminationMessage | null;
  close: { code: number; reason: string } | null;
  errors: Record<string, unknown>[];
  warnings: Record<string, unknown>[];
  audio: { frames: number; bytes: number; audioMs: number; firstFrameWall?: number; lastFrameWall?: number };
  actions: { label: string; atAudioMs: number; wallMs: number }[];
  terminateSentWall?: number;
  terminationWall?: number;
}

export async function runSession(o: RunOptions): Promise<RunResult> {
  const { log } = o;
  const auth: Auth = o.auth ?? { apiKey: API_KEY };
  if (!o.skipRateGuard) await rateGuard(log);
  const url = buildStreamingUrl(o.params, { ...("token" in auth ? { token: auth.token } : {}), ...(o.baseUrl ? { baseUrl: o.baseUrl } : {}) });
  log.event("out", {
    type: "_connect",
    url,
    auth: "token" in auth ? (auth.token ? "query ?token=" : "none") : `header Authorization (${auth.apiKey.startsWith("Bearer ") ? "Bearer + key" : "raw key"})`,
    impl: o.impl ?? "ws",
    params: o.params,
  });
  const res: RunResult = {
    ok: false,
    url,
    events: [],
    turns: [],
    finals: [],
    tracker: new TurnTracker(),
    termination: null,
    close: null,
    errors: [],
    warnings: [],
    audio: { frames: 0, bytes: 0, audioMs: 0 },
    actions: [],
  };
  const tConnect = performance.now();
  let t0 = tConnect; // re-anchored when audio starts
  const now = () => Math.round((performance.now() - t0) * 10) / 10;

  let session: StreamingSession;
  try {
    session = await StreamingSession.connect({
      auth,
      params: o.params as StreamingParams,
      ...(o.baseUrl ? { baseUrl: o.baseUrl } : {}),
      connectTimeoutMs: o.connectTimeoutMs ?? 8000,
      factory: o.impl === "global" ? globalFactory : wsFactory,
      validateChunkDuration: false, // the smoke tests deliberately send bad frames
      sanitize: false, // ...and over-limit params
      onFrame: (dir, frame, meta) => {
        if (dir === "in") {
          const w = now();
          res.events.push({ wallMs: w, msg: frame as Record<string, unknown> });
          log.in(frame, { wallMs: w });
        } else if (meta.binaryBytes !== undefined) {
          log.tally("audio_out_frames", meta.binaryBytes);
        } else {
          log.out(frame, { wallMs: now() });
        }
      },
    });
  } catch (e) {
    const err = e as StreamingConnectError;
    res.connectError = { message: err.message, ...(err.details ?? {}) };
    res.close = err.details?.closeCode !== undefined ? { code: err.details.closeCode, reason: err.details.closeReason ?? "" } : null;
    res.connectMs = Math.round(performance.now() - tConnect);
    log.note("connect failed", res.connectError);
    return res;
  }
  res.connectMs = Math.round(performance.now() - tConnect);
  res.begin = session.begin;
  log.note("connected", { connectMs: res.connectMs, beginAt: "see Begin event" });

  session.on("turn", (t) => {
    const w = now();
    res.turns.push({ wallMs: w, msg: t });
    const kind = res.tracker.apply(t);
    if (kind === "final" || kind === "duplicate-final") res.finals.push({ wallMs: w, turn: t });
  });
  session.on("speakerRevision", (r: SpeakerRevisionMessage) => res.tracker.applyRevision(r));
  session.on("error", (e) => res.errors.push({ wallMs: now(), ...e }));
  session.on("warning", (w) => res.warnings.push({ wallMs: now(), ...w }));

  // ---- audio ----
  let stop = false;
  session.on("error", () => {
    if (o.stopOnError !== false) stop = true;
  });
  t0 = performance.now();
  if (o.customSend) {
    await o.customSend(session, t0);
  } else if (o.fixture) {
    const f = o.fixture;
    const chunkMs = o.chunkMs ?? 50;
    const speed = o.speed ?? 1;
    const frameBytes = Math.round((f.sampleRate * chunkMs) / 1000) * f.bytesPerSample;
    const bytesPerMs = (f.sampleRate * f.bytesPerSample) / 1000;
    const pending = [...(o.schedule ?? [])].sort((a, b) => a.atAudioMs - b.atAudioMs);
    let sentMs = 0;
    for (let off = 0; off < f.bytes.byteLength; off += frameBytes) {
      if (stop || !session.isOpen) break;
      const frame = f.bytes.subarray(off, Math.min(off + frameBytes, f.bytes.byteLength));
      const frameMs = frame.byteLength / bytesPerMs;
      const due = (sentMs + frameMs) / speed;
      const wait = due - (performance.now() - t0);
      if (wait > 1) await sleep(wait);
      // scheduled actions due at or before this audio position
      while (pending.length && pending[0]!.atAudioMs <= sentMs) {
        const a = pending.shift()!;
        res.actions.push({ label: a.label, atAudioMs: a.atAudioMs, wallMs: now() });
        log.note(`action: ${a.label}`, { atAudioMs: a.atAudioMs, wallMs: now() });
        a.run(session);
      }
      if (frame.byteLength / bytesPerMs < 50 && chunkMs >= 50) {
        // pad the tail frame to 50 ms of silence so it doesn't trigger 3007
        const padded = new Uint8Array(Math.round(50 * bytesPerMs)).fill(f.bytesPerSample === 1 ? 0xff : 0);
        padded.set(frame);
        session.sendAudio(padded);
        res.audio.bytes += padded.byteLength;
      } else {
        session.sendAudio(frame);
        res.audio.bytes += frame.byteLength;
      }
      if (res.audio.frames === 0) res.audio.firstFrameWall = now();
      res.audio.lastFrameWall = now();
      res.audio.frames++;
      sentMs += frameMs;
    }
    res.audio.audioMs = Math.round(sentMs);
    for (const a of pending) log.note(`action not run (audio ended/stopped): ${a.label}`, { atAudioMs: a.atAudioMs });
    log.note("audio done", { ...res.audio, stoppedEarly: stop });
  } else if (o.idleMs) {
    await sleep(o.idleMs);
  }

  // ---- tail + terminate ----
  if (session.isOpen && (o.fixture || o.customSend)) await Promise.race([sleep(o.tailMs ?? 1500), session.closed]);
  if (session.isOpen && !o.noTerminate) {
    res.terminateSentWall = now();
    const term = await session.terminate({ timeoutMs: 15000 });
    res.termination = term;
  } else if (o.noTerminate && session.isOpen) {
    // wait for the server to close (bounded), then make sure we don't leak a billed session
    await Promise.race([session.closed, sleep(20000)]);
    if (session.isOpen) {
      log.note("server did not close within 20 s: sending Terminate");
      res.terminateSentWall = now();
      res.termination = await session.terminate({ timeoutMs: 15000 });
    }
  }
  await Promise.race([session.closed, sleep(3000)]);
  res.close = session.closeInfo;
  res.termination = res.termination ?? session.termination;
  const termEv = res.events.find((e) => (e.msg as { type?: string }).type === "Termination");
  if (termEv) res.terminationWall = termEv.wallMs;
  log.note("closed", { close: res.close, termination: res.termination, terminateSentWall: res.terminateSentWall, terminationWall: res.terminationWall });
  res.ok = true;
  return res;
}

// ---------------------------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------------------------

/** Collapse runs of single-char tokens ("h p 7 7 4" -> "hp774") and strip punctuation. */
export function normalizeForWer(s: string): string[] {
  const t = s
    .toLowerCase()
    .replace(/(\d),(\d{3})/g, "$1$2")
    .replace(/\bp\.\s?m\.?/g, "pm")
    .replace(/\ba\.\s?m\.?/g, "am")
    .replace(/(\d)-(?=\d)/g, "$1")
    .replace(/[^a-z0-9\s']/g, " ")
    .replace(/'/g, "")
    .split(/\s+/)
    .filter(Boolean);
  const out: string[] = [];
  let run = "";
  for (const w of t) {
    if (w.length === 1 && /[a-z0-9]/.test(w)) {
      run += w;
      continue;
    }
    if (run) {
      if (/^\d+$/.test(w) && run.length > 1) {
        run += w; // "h p 7 7 4" + "0391"
        continue;
      }
      out.push(run);
      run = "";
    }
    out.push(w);
  }
  if (run) out.push(run);
  // join letter-prefix + digits split ("hp" "7740391" -> "hp7740391", "cl" "44812")
  const joined: string[] = [];
  for (let i = 0; i < out.length; i++) {
    const a = out[i]!;
    const b = out[i + 1];
    if (b && /^[a-z]{1,2}$/.test(a) && /^\d{4,}$/.test(b) && (a === "hp" || a === "cl")) {
      joined.push(a + b);
      i++;
    } else joined.push(a);
  }
  return joined;
}

export function wer(ref: string, hyp: string): { wer: number; ref: number; sub: number; del: number; ins: number } {
  const r = normalizeForWer(ref);
  const h = normalizeForWer(hyp);
  const n = r.length;
  const m = h.length;
  const d: number[][] = Array.from({ length: n + 1 }, (_, i) => Array.from({ length: m + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= n; i++)
    for (let j = 1; j <= m; j++) {
      const c = r[i - 1] === h[j - 1] ? 0 : 1;
      d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + c);
    }
  // backtrace for S/D/I counts
  let i = n,
    j = m,
    sub = 0,
    del = 0,
    ins = 0;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && d[i]![j] === d[i - 1]![j - 1]! + (r[i - 1] === h[j - 1] ? 0 : 1)) {
      if (r[i - 1] !== h[j - 1]) sub++;
      i--;
      j--;
    } else if (i > 0 && d[i]![j] === d[i - 1]![j]! + 1) {
      del++;
      i--;
    } else {
      ins++;
      j--;
    }
  }
  return { wer: n ? Math.round((d[n]![m]! / n) * 1000) / 10 : 0, ref: n, sub, del, ins };
}

export const DIALOG_ENTITIES = [
  "harborpoint",
  "danielreyes",
  "priyashah",
  "hp7740391",
  "7740391",
  "september15",
  "5pm",
  "1420maple",
  "springfield",
  "markdonnelly",
  "lakesideautobody",
  "3450",
  "125",
  "500",
  "7pm",
  "4155550137",
  "88birchwood",
  "cl44812",
  "44812",
  "friday",
  "10am",
];

export function entityHits(text: string, expect = DIALOG_ENTITIES): { hit: string[]; missing: string[] } {
  const norm = text
    .toLowerCase()
    .replace(/\bp\.\s?m\.?/g, "pm")
    .replace(/\ba\.\s?m\.?/g, "am")
    .replace(/(\d+)(st|nd|rd|th)\b/g, "$1")
    .replace(/[^a-z0-9]/g, "");
  const hit: string[] = [];
  const missing: string[] = [];
  for (const e of expect) (norm.includes(e) ? hit : missing).push(e);
  return { hit, missing };
}

/** Which script turn contains audio time `ms` (gaps are attributed to the nearer turn). */
export function scriptTurnAt(turns: ScriptTurn[], ms: number): ScriptTurn | undefined {
  let best: ScriptTurn | undefined;
  let bestDist = Infinity;
  for (const t of turns) {
    const dist = ms < t.start_ms ? t.start_ms - ms : ms > t.end_ms ? ms - t.end_ms : 0;
    if (dist < bestDist) {
      bestDist = dist;
      best = t;
    }
  }
  return best;
}

export interface TurnLatencyRow {
  turn_order: number;
  transcript: string;
  scriptTurns: number[];
  merged: boolean;
  lastWordEndMs: number;
  scriptEndMs: number;
  finalWallMs: number;
  /** finalWall - scriptEnd (end of speech per script). */
  eotLatencyMs: number;
  /** finalWall - last word end (server word timestamp). */
  eotLatencyVsWordMs: number;
  firstPartialWallMs?: number;
  /** first partial wall - script start of the first script turn in this Turn. */
  firstPartialLatencyMs?: number;
  speechStartedWallMs?: number;
  speechStartedLatencyMs?: number;
  speaker_label?: string;
}

export function turnLatencies(res: RunResult, script: ScriptTurn[]): TurnLatencyRow[] {
  const rows: TurnLatencyRow[] = [];
  // first partial per turn_order, SpeechStarted preceding each turn
  const firstMsg = new Map<number, number>();
  for (const e of res.turns) {
    const t = e.msg as TurnMessage;
    if (!firstMsg.has(t.turn_order)) firstMsg.set(t.turn_order, e.wallMs);
  }
  const speechStarted = res.events.filter((e) => (e.msg as { type?: string }).type === "SpeechStarted");
  for (const f of res.finals) {
    const t = f.turn;
    if (!t.words?.length) continue;
    const first = t.words[0]!;
    const last = t.words[t.words.length - 1]!;
    const sFirst = scriptTurnAt(script, first.start)!;
    const sLast = scriptTurnAt(script, last.end)!;
    const idxs: number[] = [];
    for (let i = sFirst.index; i <= sLast.index; i++) idxs.push(i);
    const fp = firstMsg.get(t.turn_order);
    const ss = speechStarted.filter((e) => e.wallMs <= (fp ?? f.wallMs)).pop();
    const row: TurnLatencyRow = {
      turn_order: t.turn_order,
      transcript: t.transcript,
      scriptTurns: idxs,
      merged: idxs.length > 1,
      lastWordEndMs: last.end,
      scriptEndMs: sLast.end_ms,
      finalWallMs: f.wallMs,
      eotLatencyMs: Math.round(f.wallMs - sLast.end_ms),
      eotLatencyVsWordMs: Math.round(f.wallMs - last.end),
      ...(t.speaker_label !== undefined ? { speaker_label: t.speaker_label } : {}),
    };
    if (fp !== undefined) {
      row.firstPartialWallMs = fp;
      row.firstPartialLatencyMs = Math.round(fp - sFirst.start_ms);
    }
    if (ss) {
      row.speechStartedWallMs = ss.wallMs;
      row.speechStartedLatencyMs = Math.round(ss.wallMs - sFirst.start_ms);
    }
    rows.push(row);
  }
  return rows;
}

export function stats(xs: number[]): { n: number; p50: number; p90: number; min: number; max: number; mean: number } | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))]!;
  return { n: s.length, p50: q(0.5), p90: q(0.9), min: s[0]!, max: s[s.length - 1]!, mean: Math.round(s.reduce((a, b) => a + b, 0) / s.length) };
}

/** Word-level and turn-level diarization accuracy vs the script (best label->speaker mapping). */
export function diarizationAccuracy(finals: TurnMessage[], script: ScriptTurn[]) {
  const pairs: { label: string; ref: string }[] = [];
  let pending = 0;
  let missing = 0;
  for (const t of finals)
    for (const w of t.words ?? []) {
      if (w.speaker === undefined) {
        missing++;
        continue;
      }
      if (w.speaker === "PENDING") {
        pending++;
        continue;
      }
      const ref = scriptTurnAt(script, (w.start + w.end) / 2)!.speaker;
      pairs.push({ label: w.speaker, ref });
    }
  const labels = [...new Set(pairs.map((p) => p.label))];
  // map each label to the speaker it co-occurs with most
  const mapping: Record<string, string> = {};
  for (const l of labels) {
    const c: Record<string, number> = {};
    for (const p of pairs) if (p.label === l) c[p.ref] = (c[p.ref] ?? 0) + 1;
    mapping[l] = Object.entries(c).sort((a, b) => b[1] - a[1])[0]![0];
  }
  const correct = pairs.filter((p) => mapping[p.label] === p.ref).length;
  // turn level
  const turnRows = finals.map((t) => {
    const refs = (t.words ?? []).map((w) => scriptTurnAt(script, (w.start + w.end) / 2)!.speaker);
    const refMajority = Object.entries(refs.reduce<Record<string, number>>((a, r) => ((a[r] = (a[r] ?? 0) + 1), a), {})).sort((a, b) => b[1] - a[1])[0]?.[0];
    return { turn_order: t.turn_order, label: t.speaker_label, ref: refMajority, mixedSpeakers: new Set(refs).size > 1, ok: t.speaker_label !== undefined && mapping[t.speaker_label] === refMajority };
  });
  return {
    labels,
    mapping,
    words: { scored: pairs.length, correct, accuracy: pairs.length ? Math.round((correct / pairs.length) * 1000) / 10 : null, pending, missingSpeakerField: missing },
    turns: { total: turnRows.length, correct: turnRows.filter((r) => r.ok).length, mixedSpeakerTurns: turnRows.filter((r) => r.mixedSpeakers).length, rows: turnRows },
  };
}

/** Compact event-type census. */
export function census(res: RunResult): Record<string, number> {
  const c: Record<string, number> = {};
  for (const e of res.events) {
    const m = e.msg as { type?: string; error?: unknown };
    const k = m.type ?? ("error" in m ? "Error(untyped)" : "unknown");
    c[k] = (c[k] ?? 0) + 1;
  }
  return c;
}

/** Truncated verbatim copy of a message for the report. */
export function brief(msg: unknown, maxWords = 3): unknown {
  if (!msg || typeof msg !== "object") return msg;
  const m = { ...(msg as Record<string, unknown>) };
  if (Array.isArray(m.words) && m.words.length > maxWords) m.words = [...m.words.slice(0, maxWords), `...+${m.words.length - maxWords} words`];
  return m;
}

export function saveSummary(test: string, summary: unknown): string {
  const p = resolve(OUT_DIR, `streaming-${test}.summary.json`);
  writeFileSync(p, JSON.stringify(summary, null, 2));
  return p;
}
