/**
 * client/hud/latency.ts - the audible-latency HUD (DESIGN §5.10). Implements `LatencyHud` (services.ts) plus the
 * `LatencyHudExt` additions (contracts/ext/wp5b-va.ts).
 *
 * Every mark is on the AudioContext clock (ms), so "first audible" means the moment the judge HEARS the audio
 * (reported by the VA output worklet), not when the bytes arrived.
 *
 *   click_to_first_audible = firstAudiblePlayed(greeting) − arm
 *   dead_air_after_rep     = max(0, firstAudiblePlayed(greeting) − repLineEnd)
 *   turn_audible_latency   = firstAudiblePlayed(reply) − eos          (the customer spoke after the last agent audio)
 *   tool_turn_latency      = the same, when the reply that started before it was a tool_preamble
 *
 * `eos` comes from the feeder (exact clip end: chips, typed, autopilot) or the mic VAD / `input.speech.stopped`.
 * An `eos` is used once, and only if it is later than the previous first-audible (so a reassurance reply.create
 * with no customer speech never produces a turn metric).
 */
import "client-only";

import type { TakeoverEventsRequest } from "@/core/contracts/api";
import type { BatonEvent, HudMetric, ReplyKind } from "@/core/contracts/events";
import type { HudSnapshot, HudStat, LatencyHudExt } from "@/core/contracts/ext/wp5b-va";

export type HudMarkName = Parameters<LatencyHudExt["mark"]>[0];

export interface LatencyHudOptions {
  /** Called once per computed metric value (the controller emits a `hud` BatonEvent and posts it to /events). */
  onMetric?: (metric: HudMetric, ms: number) => void;
}

/** Nearest-rank percentile over a sorted copy (p in 0..100). */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return NaN;
  const s = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * s.length);
  return s[Math.min(s.length - 1, Math.max(0, rank - 1))]!;
}

export function statOf(values: readonly number[]): HudStat | undefined {
  if (values.length === 0) return undefined;
  return { last: values[values.length - 1]!, p50: percentile(values, 50), p90: percentile(values, 90), n: values.length };
}

export class LatencyHudImpl implements LatencyHudExt {
  private marks: { name: string; ctxMs: number; replyId?: string }[] = [];
  private values = new Map<HudMetric, number[]>();
  private sessionIds: HudSnapshot["sessionIds"] = {};
  private underruns = 0;
  private slowNetwork = false;
  private listeners = new Set<() => void>();
  private snap: HudSnapshot | null = null;
  private armAt: number | null = null;
  private repLineEndAt: number | null = null;
  private greetingDone = false;
  private pendingEos: number | null = null;
  private lastFirstAudibleAt: number | null = null;
  /** Reply ids in reply.started order, and their kinds once reply.done is known. */
  private replyOrder: string[] = [];
  private kinds = new Map<string, ReplyKind>();
  private audibleSeen = new Set<string>();
  private readonly onMetric: LatencyHudOptions["onMetric"];

  constructor(opts: LatencyHudOptions = {}) {
    this.onMetric = opts.onMetric;
  }

  mark(name: HudMarkName, ctxMs: number, replyId?: string): void {
    this.marks.push({ name, ctxMs, ...(replyId !== undefined ? { replyId } : {}) });
    switch (name) {
      case "arm":
        // a new takeover: greeting detection starts over (session ids and the other marks stay for the Explorer)
        this.armAt = ctxMs;
        this.repLineEndAt = null;
        this.greetingDone = false;
        this.pendingEos = null;
        this.lastFirstAudibleAt = null;
        this.replyOrder = [];
        this.kinds.clear();
        this.audibleSeen.clear();
        break;
      case "repLineEnd":
        this.repLineEndAt = ctxMs;
        break;
      case "eos":
        this.pendingEos = ctxMs;
        break;
      case "replyStarted":
        if (replyId !== undefined && !this.replyOrder.includes(replyId)) this.replyOrder.push(replyId);
        break;
      case "firstAudiblePlayed":
        this.onFirstAudible(ctxMs, replyId);
        break;
      default:
        break;
    }
    this.notify();
  }

  private onFirstAudible(ctxMs: number, replyId: string | undefined): void {
    if (replyId !== undefined) {
      if (this.audibleSeen.has(replyId)) return;
      this.audibleSeen.add(replyId);
    }
    if (!this.greetingDone) {
      this.greetingDone = true;
      if (this.armAt !== null) this.record("click_to_first_audible", ctxMs - this.armAt);
      if (this.repLineEndAt !== null) this.record("dead_air_after_rep", Math.max(0, ctxMs - this.repLineEndAt));
    } else if (this.pendingEos !== null && (this.lastFirstAudibleAt === null || this.pendingEos > this.lastFirstAudibleAt) && ctxMs >= this.pendingEos) {
      const metric: HudMetric = this.predecessorWasToolPreamble(replyId) ? "tool_turn_latency" : "turn_audible_latency";
      this.record(metric, ctxMs - this.pendingEos);
      this.pendingEos = null;
    }
    this.lastFirstAudibleAt = ctxMs;
  }

  private predecessorWasToolPreamble(replyId: string | undefined): boolean {
    if (replyId === undefined) return false;
    const i = this.replyOrder.indexOf(replyId);
    if (i <= 0) return false;
    return this.kinds.get(this.replyOrder[i - 1]!) === "tool_preamble";
  }

  private record(metric: HudMetric, ms: number): void {
    const v = Math.round(ms);
    const arr = this.values.get(metric) ?? [];
    arr.push(v);
    this.values.set(metric, arr);
    this.onMetric?.(metric, v);
  }

  noteReplyKind(replyId: string, kind: ReplyKind): void {
    if (!this.replyOrder.includes(replyId)) this.replyOrder.push(replyId);
    this.kinds.set(replyId, kind);
  }

  summary(): Partial<Record<HudMetric, HudStat>> {
    const out: Partial<Record<HudMetric, HudStat>> = {};
    for (const [k, v] of this.values) {
      const s = statOf(v);
      if (s) out[k] = s;
    }
    return out;
  }

  setSessionIds(ids: { rep?: string; customer?: string; va?: string }): void {
    this.sessionIds = { ...this.sessionIds, ...ids };
    this.notify();
  }

  setAudioHealth(h: { underruns?: number; slowNetwork?: boolean }): void {
    let changed = false;
    if (h.underruns !== undefined && h.underruns !== this.underruns) {
      this.underruns = h.underruns;
      changed = true;
    }
    if (h.slowNetwork !== undefined && h.slowNetwork !== this.slowNetwork) {
      this.slowNetwork = h.slowNetwork;
      changed = true;
    }
    if (changed) this.notify();
  }

  /** Stable identity until the next change (safe for React's useSyncExternalStore). */
  snapshot(): HudSnapshot {
    this.snap ??= { metrics: this.summary(), sessionIds: { ...this.sessionIds }, underruns: this.underruns, slowNetwork: this.slowNetwork, marks: [...this.marks] };
    return this.snap;
  }

  subscribe(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  reset(): void {
    this.marks = [];
    this.values.clear();
    this.sessionIds = {};
    this.underruns = 0;
    this.slowNetwork = false;
    this.armAt = null;
    this.repLineEndAt = null;
    this.greetingDone = false;
    this.pendingEos = null;
    this.lastFirstAudibleAt = null;
    this.replyOrder = [];
    this.kinds.clear();
    this.audibleSeen.clear();
    this.notify();
  }

  private notify(): void {
    this.snap = null;
    for (const l of [...this.listeners]) {
      try {
        l();
      } catch {
        /* a broken subscriber must not break the HUD */
      }
    }
  }
}

/**
 * The standard `onMetric`: a `hud` BatonEvent for the UI/replay bundle and a POST to /api/takeovers/[id]/events
 * (DESIGN §5.10 "Values are posted"). Posting is best effort.
 */
export function hudMetricReporter(o: {
  sink: { emit(ev: BatonEvent): void };
  postEvents?: (body: TakeoverEventsRequest) => Promise<void>;
  eventTime: () => number;
}): (metric: HudMetric, ms: number) => void {
  return (metric, ms) => {
    try {
      o.sink.emit({ t: o.eventTime(), type: "hud", metric, ms });
    } catch {
      /* the UI must not break the HUD */
    }
    void o.postEvents?.({ hud: { [metric]: ms } }).catch(() => undefined);
  };
}

export function createLatencyHud(opts: LatencyHudOptions = {}): LatencyHudImpl {
  return new LatencyHudImpl(opts);
}
