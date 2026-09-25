import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

import type { OpenedChannel, OpenedSessions } from "../../../../src/core/scenario/stt-run";
import { runSttCache } from "../../../../src/core/scenario/stt-run";
import type { SttVariant } from "../../../../src/core/contracts/eval";

export const tmp = (prefix: string): string => mkdtempSync(join(tmpdir(), `wp9-${prefix}-`));

/** sha256 of every file under `dir` (relative path → hash): proves a build did not touch its inputs. */
export function treeHash(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string, rel: string) => {
    for (const n of readdirSync(d).sort()) {
      const p = join(d, n);
      const r = rel ? `${rel}/${n}` : n;
      if (statSync(p).isDirectory()) walk(p, r);
      else out[r] = `${createHash("sha256").update(readFileSync(p)).digest("hex")}:${statSync(p).mtimeMs}`;
    }
  };
  walk(dir, "");
  return out;
}

export interface Scripted {
  /** Emit `msg` once this much audio (ms) has been received. */
  atMs: number;
  msg: Record<string, unknown>;
}

export const turn = (order: number, text: string, final: boolean, startMs: number, endMs: number, speaker?: string): Record<string, unknown> => {
  const ws = text.split(" ").filter(Boolean);
  const step = ws.length ? (endMs - startMs) / ws.length : 0;
  return {
    type: "Turn",
    turn_order: order,
    turn_is_formatted: final,
    end_of_turn: final,
    transcript: text,
    end_of_turn_confidence: final ? 0.9 : 0.1,
    words: ws.map((w, i) => ({ text: w, start: Math.round(startMs + i * step), end: Math.round(startMs + (i + 1) * step), confidence: 0.95, word_is_final: final, ...(speaker ? { speaker } : {}) })),
  };
};

/** A fake Streaming session: counts audio ms (µ-law 8 kHz) and emits scripted messages when their time is reached. */
export class FakeSession {
  readonly sent: number[] = [];
  readonly updates: string[] = [];
  private listeners = new Set<(m: Record<string, unknown>) => void>();
  private ms = 0;
  private queue: Scripted[];
  closed = false;
  readonly begin = { type: "Begin", id: `sess-${Math.random().toString(36).slice(2, 8)}`, expires_at: 0 };
  constructor(script: Scripted[], private readonly closeAtMs: number | null = null) {
    this.queue = [...script].sort((a, b) => a.atMs - b.atMs);
  }
  on(_t: "message", fn: (m: Record<string, unknown>) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  sendAudio(frame: Uint8Array): boolean {
    if (this.closed) return false;
    this.sent.push(frame.byteLength);
    this.ms += frame.byteLength / 8;
    while (this.queue.length && this.queue[0]!.atMs <= this.ms) this.emit(this.queue.shift()!.msg);
    if (this.closeAtMs !== null && this.ms >= this.closeAtMs) this.closed = true;
    return true;
  }
  updateConfiguration(p: { agent_context?: string }): boolean {
    if (p.agent_context) this.updates.push(p.agent_context);
    return true;
  }
  emit(m: Record<string, unknown>) {
    for (const fn of this.listeners) fn(m);
  }
  async close() {
    for (const q of this.queue.splice(0)) this.emit(q.msg);
    const term = { type: "Termination", audio_duration_seconds: this.ms / 1000, session_duration_seconds: Math.ceil(this.ms / 1000) };
    this.emit(term);
    this.closed = true;
    return term;
  }
}

export const opened = (s: FakeSession, params: Record<string, unknown> = { speech_model: "universal-3-5-pro" }): OpenedChannel => ({ session: s, close: () => s.close(), params });

/** A complete pc_ctx/pc_noctx cache for a take of `ms` audio, produced by the real runner over fake sessions. */
export async function fakeCache(callId: string, variant: SttVariant, audioMs: number, rep: Scripted[], customer: Scripted[]) {
  const n = Math.round(audioMs * 8);
  const r = new FakeSession(rep);
  const c = new FakeSession(customer);
  let clock = 0;
  const res = await runSttCache(
    { callId, variant, audio: { rep: new Uint8Array(n).fill(0xff), customer: new Uint8Array(n).fill(0xff) }, ctxCarry: variant === "pc_ctx" ? "last_rep_turn" : "none" },
    { open: async (): Promise<OpenedSessions> => ({ rep: opened(r), customer: opened(c) }), now: () => clock, sleep: async (ms) => void (clock += ms), isoNow: () => "2026-09-25T05:00:00.000Z" },
  );
  return { ...res, rep: r, customer: c };
}
