/**
 * cached-replay.ts - the labelled cached-turn replay (DESIGN §5.1.10, G0 contract decision 8).
 *
 * `public/data/cached-turns/<callId>.json` holds the raw Streaming `Turn` messages (partials and finals) of the
 * call's per-channel `pc_ctx` session, each stamped with `recvMs` on the call clock (that session started at call
 * ms 0). On every CallPlayer tick, each ACTIVE channel emits the records with `recvMs ≤ callMs` through the same
 * `TurnTracker` as live, so finals land within one tick (≤ 50 ms) of their original arrival time:
 *   partial → `stt.partial`; final → a TurnInput with `cachedTurnIdOf(ch, turn_order)` and `source:"stt_cache"`
 *   → `CaseSync.enqueue` (the server serves cached fact events for it) + `stt.final`.
 * Channels activate independently: the whole call (denied / failed / "Watch the cached replay now") or one channel
 * after a failed reconnect ("partially cached"). The mode label is emitted once: `{type:"mode", mode:"cached_replay"}`
 * plus a `fallback` event with the tooltip text.
 */
import "client-only";

import { TurnTracker, type TurnMessage } from "@/core/aai/streaming";
import type { Channel } from "@/core/contracts/case";
import { CachedTurnsFileSchema, type CachedTurnsFile } from "@/core/contracts/eval";
import type { CaseSync, EventSink } from "@/core/contracts/services";
import { cachedTurnIdOf, type TurnInput } from "@/core/contracts/turns";

export interface CachedReplayOptions {
  caseId: string;
  sink: EventSink;
  caseSync: Pick<CaseSync, "enqueue">;
  /** Event clock (ms since page session start). */
  now(): number;
  takeover?: () => { armed: boolean; tArmMs: number | null };
  fetchImpl?: typeof fetch;
  /** `CreateCaseResponse.cachedTurnsUrl`; `ensureLoaded()` fetches it (prefetch it when the run starts). */
  url?: string | null;
}

interface ChannelCursor {
  active: boolean;
  next: number;
  fromCallMs: number;
  tracker: TurnTracker;
}

export interface CachedEmission {
  channel: Channel;
  turnId: string;
  recvMs: number;
  /** Call clock of the tick that emitted it (the lag is emittedAtMs − recvMs, 0..one tick). */
  emittedAtMs: number;
}

export class CachedReplay {
  private readonly o: CachedReplayOptions;
  private file: CachedTurnsFile | null = null;
  private loading: Promise<CachedTurnsFile> | null = null;
  private readonly cur: Record<Channel, ChannelCursor> = {
    rep: { active: false, next: 0, fromCallMs: 0, tracker: new TurnTracker() },
    customer: { active: false, next: 0, fromCallMs: 0, tracker: new TurnTracker() },
  };
  private labelled = false;
  /** Every final emitted (for the ±50 ms acceptance check and the dev page). */
  readonly emissions: CachedEmission[] = [];

  constructor(o: CachedReplayOptions) {
    this.o = o;
  }

  /** Accepts a parsed file (tests, prefetch) or fetches `url` once. */
  load(src: string | CachedTurnsFile): Promise<CachedTurnsFile> {
    if (typeof src !== "string") {
      this.file = CachedTurnsFileSchema.parse(src);
      this.loading = Promise.resolve(this.file);
      return this.loading;
    }
    if (!this.loading) {
      const f = this.o.fetchImpl ?? fetch.bind(globalThis);
      this.loading = f(src)
        .then(async (r) => {
          if (!r.ok) throw new Error(`cached turns ${src}: HTTP ${r.status}`);
          return CachedTurnsFileSchema.parse(await r.json());
        })
        .then((file) => (this.file = file))
        .catch((e: unknown) => {
          this.loading = null;
          throw e;
        });
    }
    return this.loading;
  }

  /** Load from `url` (once). Rejects when there is no URL (the call has no public cached turns). */
  ensureLoaded(): Promise<CachedTurnsFile> {
    if (this.loading) return this.loading;
    if (!this.o.url) return Promise.reject(new Error("no cached turns for this call"));
    return this.load(this.o.url);
  }

  get loaded(): boolean {
    return this.file !== null;
  }
  get transcribedAt(): string | null {
    return this.file?.transcribedAt ?? null;
  }

  isActive(ch: Channel): boolean {
    return this.cur[ch].active;
  }

  /**
   * Start replaying `ch` (or both) from `fromCallMs`: records with `recvMs < fromCallMs` are skipped (they are
   * already in the case: Express prefill, or the live session covered them). Idempotent per channel.
   */
  activate(ch: Channel | "both", fromCallMs: number, reason: string): void {
    if (!this.file) throw new Error("CachedReplay.activate before load()");
    const chans: Channel[] = ch === "both" ? ["rep", "customer"] : [ch];
    for (const c of chans) {
      const k = this.cur[c];
      if (k.active) continue;
      const recs = this.file.channels[c];
      let i = 0;
      while (i < recs.length && recs[i]!.recvMs < fromCallMs) i++;
      k.active = true;
      k.next = i;
      k.fromCallMs = fromCallMs;
    }
    if (!this.labelled) {
      this.labelled = true;
      const t = this.o.now();
      this.o.sink.emit({ t, type: "mode", mode: "cached_replay", reason });
      this.o.sink.emit({
        t,
        type: "fallback",
        kind: "cached_turn_replay",
        label: `CACHED REPLAY: ${reason}. Transcribed live by AssemblyAI on ${this.file.transcribedAt.slice(0, 10)}; replayed now.`,
      });
    }
  }

  deactivate(ch: Channel | "both"): void {
    for (const c of ch === "both" ? (["rep", "customer"] as const) : [ch]) this.cur[c].active = false;
  }

  hasOpenPartial(ch: Channel): boolean {
    return this.cur[ch].active && this.cur[ch].tracker.hasOpenPartial();
  }

  /** Drive from the CallPlayer tick (call clock). */
  onTick(callMs: number): void {
    if (!this.file) return;
    for (const ch of ["rep", "customer"] as const) {
      const k = this.cur[ch];
      if (!k.active) continue;
      const recs = this.file.channels[ch];
      while (k.next < recs.length && recs[k.next]!.recvMs <= callMs) {
        const rec = recs[k.next++]!;
        this.emit(ch, rec.message as unknown as TurnMessage, rec.recvMs, callMs);
      }
    }
  }

  private emit(ch: Channel, msg: TurnMessage, recvMs: number, callMs: number): void {
    if (!msg || msg.type !== "Turn") return;
    const k = this.cur[ch];
    const r = k.tracker.apply(msg);
    const t = this.o.now();
    if (r === "partial") {
      this.o.sink.emit({ t, type: "stt.partial", channel: ch, turnOrder: msg.turn_order, text: msg.transcript });
      return;
    }
    if (r !== "final") return;
    const words = (msg.words ?? []).map((w) => ({ text: w.text, startMs: w.start, endMs: w.end, confidence: w.confidence }));
    const tk = this.o.takeover?.();
    const endMs = words.at(-1)?.endMs ?? recvMs;
    const turn: TurnInput = {
      caseId: this.o.caseId,
      turnId: cachedTurnIdOf(ch, msg.turn_order),
      channel: ch,
      text: msg.transcript,
      startMs: words[0]?.startMs ?? recvMs,
      endMs,
      words,
      source: "stt_cache",
      recvMs,
      cut: false,
      late: !!tk?.armed && tk.tArmMs !== null && endMs > tk.tArmMs,
    };
    this.emissions.push({ channel: ch, turnId: turn.turnId, recvMs, emittedAtMs: callMs });
    this.o.caseSync.enqueue(turn);
    this.o.sink.emit({ t, type: "stt.final", turn });
  }
}
