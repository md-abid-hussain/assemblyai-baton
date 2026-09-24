/**
 * CallPlayer worklet + CallPlayback + CallFeedClock (DESIGN §5.1.2-§5.1.4): the real worklet source rendered
 * quantum by quantum, sample-exact STT bytes, ticks that never stop, the ended event, the handoff clip.
 */
import { describe, expect, it } from "vitest";
import { mulawEncode } from "../../../../src/core/audio";
import { CallFeedClock, sourceWindowDb } from "../../../../src/client/audio/call-clock";
import { CallPlayer, type SpanAudioContext } from "../../../../src/client/audio/call-player";
import { CALL_PLAYER_PROCESSOR, CALL_PLAYER_WORKLET_SOURCE } from "../../../../src/client/audio/worklets/call-player.worklet";
import type { CallTick } from "../../../../src/core/contracts/services";
import { loadWorklet, ofType, QUANTUM, type WorkletRig } from "./worklet-harness";

const CTX = 48_000;

function tone(n: number, rate: number, hz: number, amp = 0.5): Int16Array {
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.round(Math.sin((2 * Math.PI * hz * i) / rate) * amp * 32767);
  return out;
}
function pcmBytes(s: Int16Array): Uint8Array {
  return new Uint8Array(s.buffer.slice(0));
}

interface Scheduled { startAt: number; buffer: { duration: number; L: Float32Array; R: Float32Array }; end(): void }
function fakeCtx(rig: WorkletRig): SpanAudioContext & { scheduled: Scheduled[] } {
  const scheduled: Scheduled[] = [];
  return {
    sampleRate: CTX,
    get currentTime() {
      return rig.currentTime;
    },
    destination: {} as AudioNode,
    scheduled,
    createBuffer(_ch: number, length: number, rate: number) {
      const L = new Float32Array(length);
      const R = new Float32Array(length);
      return { duration: length / rate, length, getChannelData: (i: number) => (i === 0 ? L : R) } as unknown as AudioBuffer;
    },
    createBufferSource() {
      const src = {
        buffer: null as unknown as AudioBuffer,
        onended: null as null | (() => void),
        connect() {},
        disconnect() {},
        start(at: number) {
          const b = src.buffer as unknown as { duration: number; getChannelData(i: number): Float32Array };
          scheduled.push({ startAt: at, buffer: { duration: b.duration, L: b.getChannelData(0), R: b.getChannelData(1) }, end: () => src.onended?.() });
        },
      };
      return src as unknown as AudioBufferSourceNode;
    },
    createGain() {
      return { gain: { setTargetAtTime() {} }, connect() {}, disconnect() {} } as unknown as GainNode;
    },
  };
}

function makePlayer(opts: { rate: 8000 | 16000; rep: Int16Array; customer: Int16Array }) {
  const rig = loadWorklet(CALL_PLAYER_WORKLET_SOURCE, CALL_PLAYER_PROCESSOR, CTX);
  const ctx = fakeCtx(rig);
  const format = opts.rate === 8000 ? ({ encoding: "pcm_mulaw", sampleRate: 8000 } as const) : ({ encoding: "pcm_s16le", sampleRate: 16000 } as const);
  const srcBytes = opts.rate === 8000
    ? { rep: mulawEncode(opts.rep), customer: mulawEncode(opts.customer) }
    : { rep: pcmBytes(opts.rep), customer: pcmBytes(opts.customer) };
  const player = new CallPlayer({ ctx, node: rig.node, duckGain: null, format, srcBytes });
  const ticks: CallTick[] = [];
  player.onTick((t) => ticks.push(t));
  let ended = 0;
  player.onEnded(() => ended++);
  return { rig, ctx, player, ticks, srcBytes, ended: () => ended };
}

describe("CallFeedClock (pure)", () => {
  it("hands out exactly (callMs − startOffset) of source bytes, sample-exact, for any tick cadence", () => {
    const rep = new Uint8Array(8000).map((_, i) => i & 0xff);
    const clock = new CallFeedClock({ srcRate: 8000, bytesPerSample: 1, silenceByte: 0xff, rep, customer: rep }, 44_100);
    clock.start(250);
    expect(clock.offsetMs).toBe(250);
    let total = 0;
    let frame = 0;
    for (const step of [2205, 2205, 2206, 128, 999, 4410]) {
      frame += step;
      const t = clock.tick(frame, true);
      total += t.rep.byteLength;
      expect(t.rep.byteLength).toBe(t.customer.byteLength);
      expect(total).toBe(Math.floor((frame * 8000) / 44_100));
      expect(t.callMs).toBeCloseTo(250 + (total / 8000) * 1000, 9);
    }
    // the bytes are the source bytes starting at sample 2000 (250 ms)
    const clock2 = new CallFeedClock({ srcRate: 8000, bytesPerSample: 1, silenceByte: 0xff, rep, customer: rep }, 48_000);
    clock2.start(250);
    expect([...clock2.tick(2400, true).rep.subarray(0, 3)]).toEqual([2000 & 0xff, 2001 & 0xff, 2002 & 0xff]);
  });

  it("not playing → silence of the same length (0xFF µ-law / 0x00 PCM16); past the end → padded silence", () => {
    const rep = new Uint8Array(800).fill(0x10);
    const c = new CallFeedClock({ srcRate: 8000, bytesPerSample: 1, silenceByte: 0xff, rep, customer: rep }, 48_000);
    c.start(0);
    const t1 = c.tick(2400, false);
    expect(t1.rep.byteLength).toBe(400);
    expect(t1.rep.every((b) => b === 0xff)).toBe(true);
    const t2 = c.tick(7200, true); // samples 400..1200, source ends at 800
    expect(t2.rep.byteLength).toBe(800);
    expect(t2.rep.subarray(0, 400).every((b) => b === 0x10)).toBe(true);
    expect(t2.rep.subarray(400).every((b) => b === 0xff)).toBe(true);
    const p = new CallFeedClock({ srcRate: 16000, bytesPerSample: 2, silenceByte: 0, rep: new Uint8Array(100).fill(7), customer: new Uint8Array(0) }, 48_000);
    p.start(0);
    const t3 = p.tick(4800, true);
    expect(t3.rep.byteLength).toBe(3200);
    expect(t3.customer.every((b) => b === 0)).toBe(true);
  });

  it("start() snaps fractional offsets to a whole source sample", () => {
    const c = new CallFeedClock({ srcRate: 8000, bytesPerSample: 1, silenceByte: 0xff, rep: new Uint8Array(10), customer: new Uint8Array(10) }, 48_000);
    c.start(100.07);
    expect(c.offsetMs).toBe(100);
  });

  it("sourceWindowDb: −120 for silence, ≈ −9 dBFS for a 0.5 sine", () => {
    const s = tone(1600, 16000, 440, 0.5);
    expect(sourceWindowDb(pcmBytes(s), 2, 0, 1600, () => 0)).toBeCloseTo(-9.03, 0);
    expect(sourceWindowDb(new Uint8Array(3200), 2, 0, 1600, () => 0)).toBe(-120);
  });
});

describe("CallPlayer worklet + CallPlayback", () => {
  it("ticks every ~50 ms of frames; STT bytes total = elapsed source samples; callMs tracks frames", () => {
    const { rig, player, ticks, srcBytes } = makePlayer({ rate: 8000, rep: tone(16000, 8000, 300), customer: tone(16000, 8000, 500) });
    player.start(0);
    rig.render(375); // 375 × 128 = 48000 frames = 1.000 s
    expect(ticks.length).toBeGreaterThanOrEqual(19);
    expect(ticks.length).toBeLessThanOrEqual(20);
    const repTotal = ticks.reduce((s, t) => s + t.rep.byteLength, 0);
    expect(repTotal).toBe(Math.floor((ticks.at(-1)!.callMs * 8000) / 1000));
    expect(ticks.at(-1)!.callMs).toBeGreaterThan(950);
    // Bytes are the untouched source bytes (sent to STT unchanged, §5.1.2).
    const sent = new Uint8Array(repTotal);
    let off = 0;
    for (const t of ticks) {
      sent.set(t.rep, off);
      off += t.rep.byteLength;
    }
    expect(sent).toEqual(srcBytes.rep.subarray(0, repTotal));
    // Tick spacing: 2400 frames ± one quantum.
    for (let i = 1; i < ticks.length; i++) {
      const d = ticks[i]!.callMs - ticks[i - 1]!.callMs;
      expect(d).toBeGreaterThanOrEqual(50 - (QUANTUM / CTX) * 1000 - 0.2);
      expect(d).toBeLessThanOrEqual(50 + (QUANTUM / CTX) * 1000 + 0.2);
    }
  });

  it("renders the stereo mix: rep 30% left, customer 30% right", () => {
    const n = 8000;
    const rep = new Int16Array(n).fill(16384); // DC 0.5
    const customer = new Int16Array(n);
    const { rig, player } = makePlayer({ rate: 16000, rep, customer });
    player.start(0);
    const [L, R] = rig.render(10);
    expect(L![500]).toBeCloseTo(0.5 * Math.cos((0.7 * Math.PI) / 4), 3);
    expect(R![500]).toBeCloseTo(0.5 * Math.sin((0.7 * Math.PI) / 4), 3);
    expect(L![500]!).toBeGreaterThan(R![500]!);
  });

  it("stop(fade) → silence within the fade, ticks continue with playing=false and silence bytes", () => {
    const { rig, player, ticks } = makePlayer({ rate: 8000, rep: tone(80000, 8000, 300), customer: tone(80000, 8000, 500) });
    player.start(0);
    rig.render(100);
    player.stop(30);
    const n0 = ticks.length;
    const [L] = rig.render(200);
    const fadeFrames = Math.round(0.03 * CTX);
    expect(Math.max(...Array.from(L!.subarray(fadeFrames + QUANTUM)).map(Math.abs))).toBe(0);
    const after = ticks.slice(n0 + 1);
    expect(after.length).toBeGreaterThan(8);
    expect(after.every((t) => !t.playing && t.rep.every((b) => b === 0xff))).toBe(true);
    // The clock never stops.
    expect(after.at(-1)!.callMs).toBeGreaterThan(ticks[n0]!.callMs + 400);
  });

  it("start(fromMs) offsets the call clock (Express); ended fires once, then ticks keep coming with silence", () => {
    const { rig, player, ticks, ended } = makePlayer({ rate: 8000, rep: tone(8000, 8000, 300), customer: tone(8000, 8000, 500) }); // 1 s
    player.start(600);
    expect(player.startOffsetMs).toBe(600);
    rig.render(140); // 0.373 s → just short of 1.0 s
    expect(ended()).toBe(0);
    rig.render(50);
    expect(ended()).toBe(1);
    const k = ticks.length;
    rig.render(100);
    expect(ended()).toBe(1);
    expect(ticks.length).toBeGreaterThan(k + 3);
    expect(ticks.at(-1)!.playing).toBe(false);
    expect(ticks[0]!.callMs).toBeGreaterThan(600);
    expect(ofType(rig.posted, "ended")).toHaveLength(1);
  });

  it("channelEnergyDb reads the source around the playhead", () => {
    const rep = new Int16Array(16000);
    rep.set(tone(8000, 8000, 200, 0.5), 8000); // silent first second, tone second
    const { rig, player } = makePlayer({ rate: 8000, rep, customer: new Int16Array(16000) });
    player.start(0);
    rig.render(200);
    expect(player.channelEnergyDb("rep", 200)).toBeLessThan(-100);
    rig.render(250);
    expect(player.channelEnergyDb("rep", 200)).toBeGreaterThan(-15);
    expect(player.channelEnergyDb("customer", 200)).toBeLessThan(-100);
  });

  it("playHandoffClip: rep span + 300 ms + customer span, endCtxMs known at scheduling time", async () => {
    const { rig, ctx, player } = makePlayer({ rate: 8000, rep: tone(40000, 8000, 300), customer: tone(40000, 8000, 500) });
    rig.render(10);
    const r = await player.playHandoffClip({ lineStartMs: 1000, lineEndMs: 2500, acceptStartMs: 3000, acceptEndMs: 3600, declined: false });
    expect(ctx.scheduled).toHaveLength(1);
    const s = ctx.scheduled[0]!;
    expect(s.buffer.duration).toBeCloseTo(1.5 + 0.3 + 0.6, 2);
    expect(r.endCtxMs).toBeCloseTo((s.startAt + s.buffer.duration) * 1000, 6);
    // The gap is silent, the rep part is left-heavy, the customer part right-heavy.
    const at = (sec: number) => Math.round(sec * CTX);
    expect(Math.abs(s.buffer.L[at(1.65)]!)).toBe(0);
    const rms = (x: Float32Array) => Math.sqrt(x.reduce((a, v) => a + v * v, 0) / x.length);
    expect(rms(s.buffer.L.subarray(at(0.1), at(1.4)))).toBeGreaterThan(rms(s.buffer.R.subarray(at(0.1), at(1.4))));
    expect(rms(s.buffer.R.subarray(at(1.9), at(2.3)))).toBeGreaterThan(rms(s.buffer.L.subarray(at(1.9), at(2.3))));
    // no acceptance span → the rep line only
    await player.playHandoffClip({ lineStartMs: 1000, lineEndMs: 2000, acceptStartMs: null, acceptEndMs: null, declined: false });
    expect(ctx.scheduled[1]!.buffer.duration).toBeCloseTo(1.0, 2);
  });

  it("playSpan resolves when the buffer ends; dispose stops ticks", async () => {
    const { rig, ctx, player, ticks } = makePlayer({ rate: 16000, rep: tone(16000, 16000, 300), customer: tone(16000, 16000, 500) });
    const p = player.playSpan("customer", 100, 400);
    expect(ctx.scheduled).toHaveLength(1);
    ctx.scheduled[0]!.end();
    await p;
    player.start(0);
    rig.render(40);
    const n = ticks.length;
    player.dispose();
    rig.render(40);
    expect(ticks.length).toBe(n);
    expect(rig.node.disconnected).toBe(true);
  });
});
