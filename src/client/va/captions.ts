/**
 * client/va/captions.ts - agent and customer caption rules for the AI half (DESIGN §5.10 "Caption rules").
 *
 * 1. `transcript.agent.delta` words arrive in a burst. Each word is shown at
 *    playStart(reply) + (start_ms − leadingSilenceMs); a null start_ms shows at playStart.
 * 2. Nothing is shown for a reply until its first audible chunk has PLAYED. A reply with no audible chunk
 *    (tool_preamble, unspoken_text, the silent mid-hold reply of T-D1-1) never shows captions, even when
 *    `transcript.agent` text arrives for it.
 * 3. Interrupted reply: keep the words whose scheduled time is ≤ the flush time, then append "—".
 * 4. Customer lane: `transcript.user.delta.text` replaces the line (same item_id); `transcript.user` finalizes it.
 *
 * Output is `va.caption` / `va.user` BatonEvents. A `va.caption` for a replyId REPLACES earlier ones for that id
 * (the UI keys on replyId), so a truncation is simply a new, shorter event. Times are AudioContext ms.
 */
import "client-only";

import type { BatonEvent, BatonEventOf } from "@/core/contracts/events";

export const INTERRUPTED_MARK = "—";

interface ReplyCaptions {
  words: { text: string; startMs: number | null }[];
  /** ctx ms at which the first audible chunk played; null until then. */
  playStartCtxMs: number | null;
  leadingSilenceMs: number;
  interrupted: boolean;
  lastEmittedCount: number;
}

export interface CaptionSink {
  emit(ev: BatonEvent): void;
}

/** Normalise a delta word (greeting words come without trailing spaces, LLM words with them; 10a §16.20). */
const cleanWord = (w: string) => w.replace(/\s+/g, " ").trim();

export class CaptionScheduler {
  private replies = new Map<string, ReplyCaptions>();
  private readonly sink: CaptionSink;
  private readonly now: () => number;
  /** `t` of emitted BatonEvents (ms since page session start); defaults to the ctx clock. */
  private readonly eventTime: () => number;

  constructor(o: { sink: CaptionSink; nowCtxMs: () => number; eventTime?: () => number }) {
    this.sink = o.sink;
    this.now = o.nowCtxMs;
    this.eventTime = o.eventTime ?? o.nowCtxMs;
  }

  private get(replyId: string): ReplyCaptions {
    let r = this.replies.get(replyId);
    if (!r) {
      r = { words: [], playStartCtxMs: null, leadingSilenceMs: 0, interrupted: false, lastEmittedCount: 0 };
      this.replies.set(replyId, r);
    }
    return r;
  }

  /** transcript.agent.delta */
  onAgentDelta(replyId: string, delta: string, startMs: number | null | undefined): void {
    const r = this.get(replyId);
    if (r.interrupted) return;
    const text = cleanWord(delta);
    if (!text) return;
    r.words.push({ text, startMs: startMs ?? null });
    if (r.playStartCtxMs !== null) this.emit(replyId, r);
  }

  /** The reply's first audible chunk PLAYED at `ctxMs`; `leadingSilenceMs` = trimmed silent audio before it. */
  onFirstAudiblePlayed(replyId: string, ctxMs: number, leadingSilenceMs: number): void {
    const r = this.get(replyId);
    if (r.playStartCtxMs !== null) return;
    r.playStartCtxMs = ctxMs;
    r.leadingSilenceMs = leadingSilenceMs;
    if (r.words.length) this.emit(replyId, r);
  }

  /** Barge-in or flush: cut at `flushCtxMs` (default now). No-op for replies that never played. */
  interrupt(replyId: string, flushCtxMs: number = this.now()): void {
    const r = this.replies.get(replyId);
    if (!r || r.interrupted) return;
    r.interrupted = true;
    if (r.playStartCtxMs === null) return; // never audible → never captioned
    const kept = this.scheduled(r).filter((w) => w.atMs <= flushCtxMs);
    this.sink.emit({ t: this.eventTime(), type: "va.caption", replyId, words: [...kept, { text: INTERRUPTED_MARK, atMs: flushCtxMs }] });
  }

  /** Scheduled words (ctx ms) of a reply that has played; [] otherwise. */
  scheduledWords(replyId: string): { text: string; atMs: number }[] {
    const r = this.replies.get(replyId);
    return r && r.playStartCtxMs !== null ? this.scheduled(r) : [];
  }

  hasPlayed(replyId: string): boolean {
    return this.replies.get(replyId)?.playStartCtxMs != null;
  }

  private scheduled(r: ReplyCaptions): { text: string; atMs: number }[] {
    const start = r.playStartCtxMs!;
    return r.words.map((w) => ({ text: w.text, atMs: w.startMs === null ? start : Math.max(start, start + w.startMs - r.leadingSilenceMs) }));
  }

  private emit(replyId: string, r: ReplyCaptions): void {
    if (r.words.length === r.lastEmittedCount) return;
    r.lastEmittedCount = r.words.length;
    const ev: BatonEventOf<"va.caption"> = { t: this.eventTime(), type: "va.caption", replyId, words: this.scheduled(r) };
    this.sink.emit(ev);
  }

  // ---------------------------------------------------------------------------------------- customer lane (rule 4)

  private userItem: string | null = null;
  private userText = "";

  onUserDelta(itemId: string | undefined, text: string): void {
    if (itemId && itemId !== this.userItem) this.userItem = itemId;
    if (text === this.userText) return;
    this.userText = text;
    this.sink.emit({ t: this.eventTime(), type: "va.user", text, final: false });
  }

  onUserFinal(itemId: string | undefined, text: string): void {
    if (itemId) this.userItem = itemId;
    this.sink.emit({ t: this.eventTime(), type: "va.user", text, final: true });
    this.userItem = null;
    this.userText = "";
  }

  /** Forget replies (keeps memory bounded over a long session). */
  prune(keepLast = 20): void {
    const ids = [...this.replies.keys()];
    for (const id of ids.slice(0, Math.max(0, ids.length - keepLast))) this.replies.delete(id);
  }
}
