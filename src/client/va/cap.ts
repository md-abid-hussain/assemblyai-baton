/**
 * client/va/cap.ts - the dynamic, stage-aware Voice Agent session cap (DESIGN §5.9.5). Pure logic on an injected
 * clock; the controller calls `tick()` about once a second.
 *
 * - `capMs` = CompiledTakeover.vaSessionCapMs (server: min(MAX, BASE + PER_FIELD × open fields)).
 * - The wrap-up clock is PAUSED while paying: active time = elapsed − time spent in `paying`.
 * - At active ≥ capMs − 20 s, never in paying or closing: "wrap_up" (the controller sends the wrap-up reply.create) once.
 * - At active ≥ capMs, never in paying or closing: "cap" (the controller ends the session).
 * - The absolute ceiling (VA_SESSION_CAP_MAX_MS + 180 s of hold, wall time since ready) ends the session in any stage.
 */
import "client-only";

import { TAKEOVER_TIMING, vaAbsoluteCeilingMs } from "@/core/contracts/takeover";

export type CapSignal = "none" | "wrap_up" | "cap" | "ceiling";

export class SessionCap {
  readonly capMs: number;
  readonly ceilingMs: number;
  private readonly warnMs: number;
  private startedAt: number | null = null;
  private pausedTotal = 0;
  private payingSince: number | null = null;
  private closing = false;
  private wrapUpSent = false;
  private done = false;

  constructor(o: { capMs: number; vaSessionCapMaxMs: number; warnBeforeMs?: number }) {
    this.capMs = o.capMs;
    this.ceilingMs = vaAbsoluteCeilingMs(o.vaSessionCapMaxMs);
    this.warnMs = o.warnBeforeMs ?? TAKEOVER_TIMING.WRAP_UP_WARNING_MS;
  }

  start(atMs: number): void {
    this.startedAt ??= atMs;
  }

  setPaying(on: boolean, atMs: number): void {
    if (on && this.payingSince === null) this.payingSince = atMs;
    else if (!on && this.payingSince !== null) {
      this.pausedTotal += Math.max(0, atMs - this.payingSince);
      this.payingSince = null;
    }
  }

  setClosing(on: boolean): void {
    this.closing = on;
  }

  get paying(): boolean {
    return this.payingSince !== null;
  }

  /** Active (wrap-up clock) ms at `atMs`. */
  activeMs(atMs: number): number {
    if (this.startedAt === null) return 0;
    const pausedNow = this.payingSince !== null ? atMs - this.payingSince : 0;
    return Math.max(0, atMs - this.startedAt - this.pausedTotal - pausedNow);
  }

  /** The effective cap in wall ms since start (capMs + time spent paying so far). */
  effectiveCapMs(atMs: number): number {
    const pausedNow = this.payingSince !== null ? atMs - this.payingSince : 0;
    return this.capMs + this.pausedTotal + pausedNow;
  }

  tick(atMs: number): CapSignal {
    if (this.startedAt === null || this.done) return "none";
    if (atMs - this.startedAt >= this.ceilingMs) {
      this.done = true;
      return "ceiling";
    }
    if (this.paying || this.closing) return "none";
    const active = this.activeMs(atMs);
    if (active >= this.capMs) {
      this.done = true;
      return "cap";
    }
    if (!this.wrapUpSent && active >= this.capMs - this.warnMs) {
      this.wrapUpSent = true;
      return "wrap_up";
    }
    return "none";
  }
}

export const wrapUpInstructions = (repFirst: string) =>
  `Tell the customer you need to wrap up and that ${repFirst} will follow up on anything left.`;
