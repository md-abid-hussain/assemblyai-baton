/**
 * Test harness for the pure takeover reducer: a machine driven by explicit inputs on a fake ctx clock.
 * Not a test file.
 */
import type { CallHandoff } from "../../../../src/core/contracts/scenario";
import {
  defaultMachineConfig,
  initialMachineState,
  nextDeadline,
  reduce,
  type AudioSample,
  type MachineConfig,
  type TakeoverEffect,
  type TakeoverInput,
  type TakeoverMachineState,
} from "../../../../src/core/protocol/takeover-machine";
import { compiled as compiledFixture } from "../../contracts/fixtures";

export const HANDOFF: CallHandoff = { lineStartMs: 95_000, lineEndMs: 98_500, acceptStartMs: 98_800, acceptEndMs: 99_600, declined: false };

export type EffectOf<K extends TakeoverEffect["type"]> = Extract<TakeoverEffect, { type: K }>;

export class M {
  s: TakeoverMachineState;
  /** Every effect emitted so far. */
  all: TakeoverEffect[] = [];
  /** Effects of the last input. */
  last: TakeoverEffect[] = [];
  now = 10_000;
  callMs = 60_000;

  constructor(cfg: Partial<MachineConfig> = {}) {
    this.s = initialMachineState(defaultMachineConfig({ handoff: HANDOFF, hasRecordedBundle: true, ...cfg }));
  }

  send(i: TakeoverInput): TakeoverEffect[] {
    const r = reduce(this.s, i);
    this.s = r.state;
    this.last = r.effects;
    this.all.push(...r.effects);
    return r.effects;
  }

  /** Advance the clock (and the call clock while playing) and send a tick. */
  at(now: number): TakeoverEffect[] {
    this.now = now;
    return this.send({ type: "tick", now });
  }

  advance(ms: number): TakeoverEffect[] {
    return this.at(this.now + ms);
  }

  sample(o: Partial<Omit<AudioSample, "now">> & { rep?: boolean; customer?: boolean; partialRep?: boolean; partialCustomer?: boolean } = {}): TakeoverEffect[] {
    const speaking = o.speaking ?? { rep: o.rep ?? false, customer: o.customer ?? false };
    const openPartial = o.openPartial ?? { rep: o.partialRep ?? false, customer: o.partialCustomer ?? false };
    if (o.callMs !== undefined) this.callMs = o.callMs;
    return this.send({
      type: "sample",
      now: this.now,
      callMs: this.callMs,
      playing: o.playing ?? true,
      speaking,
      quiet: o.quiet ?? (!speaking.rep && !speaking.customer),
      openPartial,
    });
  }

  arm(source: "manual" | "auto_handoff" = "manual"): TakeoverEffect[] {
    return this.send({ type: "arm", now: this.now, source });
  }

  armOk(takeoverId = "tko_1", leadMs = 900): TakeoverEffect[] {
    return this.send({ type: "arm_ok", now: this.now, takeoverId, leadMs });
  }

  effects<K extends TakeoverEffect["type"]>(type: K, from: TakeoverEffect[] = this.all): EffectOf<K>[] {
    return from.filter((e): e is EffectOf<K> => e.type === type);
  }

  has(type: TakeoverEffect["type"], from: TakeoverEffect[] = this.last): boolean {
    return from.some((e) => e.type === type);
  }

  get phase() {
    return this.s.phase;
  }

  get p() {
    const p = this.s.pass;
    if (!p) throw new Error("no pass");
    return p;
  }

  get deadline(): number | null {
    return nextDeadline(this.s);
  }

  // ------------------------------------------------------------------ scripted paths

  /** Manual click while the rep is speaking; arm OK; quiet 300 ms later → sealing with an open rep partial. */
  toSealing(): this {
    this.sample({ rep: true, partialRep: true });
    this.arm();
    this.armOk();
    this.now += 300;
    this.callMs += 300;
    this.sample({ quiet: true, partialRep: true });
    return this;
  }

  toDraining(): this {
    this.toSealing();
    this.send({ type: "clip_scheduled", now: this.now, endCtxMs: this.now + 3500 });
    this.at(this.now + 250); // force endpoint
    this.now += 100;
    this.sample({ quiet: true });
    return this;
  }

  toCompiling(): this {
    this.toDraining();
    this.now += 200;
    this.send({ type: "drained", now: this.now, completedTurnIds: ["rep-3", "customer-2"], pendingTurnIds: [], waitedMs: 200 });
    return this;
  }

  /** VA token + WS open during sealing, then compile → connecting (tSend in the future). */
  toConnecting(): this {
    this.sample({ rep: true, partialRep: true });
    this.arm();
    this.armOk();
    this.now += 150;
    this.send({ type: "va_token", now: this.now, attempt: 0, liveSessionId: "va_tko_1_0" });
    this.now += 150;
    this.callMs += 300;
    this.sample({ quiet: true, partialRep: true });
    this.send({ type: "clip_scheduled", now: this.now, endCtxMs: this.now + 3500 });
    this.at(this.now + 250);
    this.now += 100;
    this.send({ type: "va_open", now: this.now, attempt: 0 });
    this.sample({ quiet: true });
    this.now += 200;
    this.send({ type: "drained", now: this.now, completedTurnIds: ["rep-3"], pendingTurnIds: [], waitedMs: 200 });
    this.now += 400;
    this.send({ type: "compiled", now: this.now, compiled: compiledFixture(), by: "server" });
    return this;
  }

  toGreeting(): this {
    this.toConnecting();
    const d = this.deadline;
    if (d === null) throw new Error("no tSend deadline");
    this.at(d);
    return this;
  }

  toActive(): this {
    this.toGreeting();
    this.now += 650;
    this.send({ type: "va_ready", now: this.now, attempt: 0, sessionId: "sess_1" });
    const repEnd = this.p.repLineEnd ?? this.now;
    this.now = Math.max(this.now, repEnd) + 300;
    this.send({ type: "va_first_audible", now: this.now, attempt: 0, ctxMs: this.now });
    return this;
  }
}

export { compiledFixture };
