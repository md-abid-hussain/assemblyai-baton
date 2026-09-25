/**
 * client/fixtures/player.ts - plays a fixture log into the console store on the page clock (dev only: /dev/ui and
 * /call?fixture=…). Supports play/pause, speed, and seeking by time or by UI phase (for screenshots).
 */
import "client-only";

import type { UiLogEntry, UiPhase } from "@/core/contracts/ext/wp7-ui";

import { initialUiState, reduceEntry } from "../store/reduce";
import type { ConsoleStore } from "../store/store";

export interface PhaseSpan {
  phase: UiPhase;
  startT: number;
  endT: number;
}

/** The phases a log walks through, with the page-clock span of each visit. */
export function phaseSpans(log: readonly UiLogEntry[]): PhaseSpan[] {
  let s = initialUiState();
  const spans: PhaseSpan[] = [{ phase: s.phase, startT: 0, endT: 0 }];
  for (const e of log) {
    s = reduceEntry(s, e);
    const cur = spans[spans.length - 1] as PhaseSpan;
    if (s.phase !== cur.phase) {
      cur.endT = e.t;
      spans.push({ phase: s.phase, startT: e.t, endT: e.t });
    } else cur.endT = e.t;
  }
  return spans;
}

/**
 * Resolve `at`: a number (ms), "end", "<phase>" (just after the phase starts) or "<phase>:end" (the last moment of
 * its first visit), optionally "+<ms>" (e.g. "paying+8000").
 */
export function resolveAt(log: readonly UiLogEntry[], at: string | null | undefined): number | null {
  if (!at) return null;
  const endT = log[log.length - 1]?.t ?? 0;
  if (/^\d+$/.test(at)) return Math.min(Number(at), endT);
  if (at === "end") return endT;
  const m = /^([a-z-]+)(:end)?(?:\+(\d+))?$/.exec(at);
  if (!m) return null;
  const span = phaseSpans(log).find((s) => s.phase === m[1]);
  if (!span) return null;
  const base = m[2] ? span.endT - 1 : span.startT;
  return Math.min(endT, base + Number(m[3] ?? 0));
}

export class FixturePlayer {
  private idx = 0;
  private t = 0;
  private wallAt = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private listeners = new Set<() => void>();
  speed = 1;

  constructor(
    private readonly store: ConsoleStore,
    readonly log: readonly UiLogEntry[],
    private readonly now: () => number = () => performance.now(),
  ) {}

  get endT(): number {
    return this.log[this.log.length - 1]?.t ?? 0;
  }
  get playing(): boolean {
    return this.timer !== null;
  }
  /** The page clock of the fixture (what BatonEvent.t means). */
  clock(): number {
    return this.timer ? Math.min(this.endT, this.t + (this.now() - this.wallAt) * this.speed) : this.t;
  }
  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
  private changed() {
    for (const l of [...this.listeners]) l();
  }

  /** Apply every entry with t ≤ target (from the start when seeking backwards). */
  seek(target: number): void {
    const wasPlaying = this.playing;
    this.stopTimer();
    if (target < this.t || this.idx === 0) {
      this.store.reset(initialUiState());
      this.idx = 0;
    }
    while (this.idx < this.log.length && (this.log[this.idx] as UiLogEntry).t <= target) this.store.apply(this.log[this.idx++] as UiLogEntry);
    this.t = target;
    if (wasPlaying) this.play();
    else this.changed();
  }

  play(): void {
    if (this.timer) return;
    if (this.t >= this.endT) this.seek(0);
    this.wallAt = this.now();
    this.timer = setInterval(() => this.tick(), 50);
    this.changed();
  }

  pause(): void {
    if (!this.timer) return;
    this.t = this.clock();
    this.stopTimer();
    this.changed();
  }

  setSpeed(x: number): void {
    const t = this.clock();
    this.speed = x;
    this.t = t;
    this.wallAt = this.now();
    this.changed();
  }

  /** Jump to the first entry of `type` (e.g. the Start click) and play from there. */
  playFrom(predicate: (e: UiLogEntry) => boolean): void {
    const e = this.log.find(predicate);
    if (e) this.seek(e.t);
    this.play();
  }

  private tick(): void {
    const t = this.clock();
    while (this.idx < this.log.length && (this.log[this.idx] as UiLogEntry).t <= t) this.store.apply(this.log[this.idx++] as UiLogEntry);
    if (t >= this.endT) {
      this.t = this.endT;
      this.stopTimer();
      this.changed();
    }
  }

  private stopTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  dispose(): void {
    this.stopTimer();
    this.listeners.clear();
  }
}
