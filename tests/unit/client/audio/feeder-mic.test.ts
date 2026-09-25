/**
 * PacedFeeder (DESIGN §5.9.2) on the real clock worklet, the mic resampler and the capture worklet.
 */
import { describe, expect, it } from "vitest";
import { FEED_FRAME_SAMPLES, FeederCore, WorkletPacedFeeder } from "../../../../src/client/audio/paced-feeder";
import { float32Db, StreamingResampler } from "../../../../src/client/audio/resampler";
import { CLOCK_PROCESSOR, CLOCK_WORKLET_SOURCE } from "../../../../src/client/audio/worklets/clock.worklet";
import { MIC_CAPTURE_PROCESSOR, MIC_CAPTURE_WORKLET_SOURCE } from "../../../../src/client/audio/worklets/mic-capture.worklet";
import { ALL_WORKLETS_SOURCE } from "../../../../src/client/audio/worklets";
import type { MicSource } from "../../../../src/core/contracts/services";
import { loadWorklet, ofType, QUANTUM, type WorkletRig } from "./worklet-harness";

const CTX = 44_100;

function feederOnClock() {
  let rig: WorkletRig | null = null;
  const feeder = new WorkletPacedFeeder({
    ctxRate: CTX,
    createClock: () => {
      rig = loadWorklet(CLOCK_WORKLET_SOURCE, CLOCK_PROCESSOR, CTX, { tickMs: 50 });
      return rig.node;
    },
  });
  return { feeder, rig: () => rig! };
}

describe("PacedFeeder", () => {
  it("nothing before start; then 50 ms = 2400 B frames at real-time pace (silence when idle)", () => {
    const { feeder, rig } = feederOnClock();
    const frames: Uint8Array[] = [];
    feeder.start((f) => frames.push(f));
    rig().render(Math.round((10 * CTX) / QUANTUM)); // 10 s
    expect(frames.length).toBeGreaterThanOrEqual(199);
    expect(frames.length).toBeLessThanOrEqual(200);
    expect(frames.every((f) => f.byteLength === 2400)).toBe(true);
    expect(frames.every((f) => f.every((b) => b === 0))).toBe(true);
    feeder.stop();
    expect(rig().node.disconnected).toBe(true);
  });

  it("clips are sent in order and resolve with endCtxMs = when their last real sample was due", async () => {
    const { feeder, rig } = feederOnClock();
    const frames: Uint8Array[] = [];
    feeder.start((f) => frames.push(f));
    const clip = new Int16Array(24_000 * 0.33).fill(1000); // 330 ms = 6.6 frames
    const p = feeder.enqueueClip(clip);
    rig().render(Math.round((1 * CTX) / QUANTUM));
    const { endCtxMs } = await p;
    expect(endCtxMs).toBeGreaterThan(330 - 60);
    expect(endCtxMs).toBeLessThan(330 + 60);
    const nonSilent = frames.filter((f) => f.some((b) => b !== 0)).length;
    expect(nonSilent).toBe(7);
    expect(feeder.core.clipFrames).toBe(7);
  });

  it("mic frames win over clips; clear() resolves pending clips", async () => {
    const core = new FeederCore();
    const clipP = core.enqueueClip(new Int16Array(24_000).fill(5));
    core.setMicActive(true);
    core.pushMic(new Int16Array(FEED_FRAME_SAMPLES * 2).fill(9));
    const g = core.onClock(Math.round(0.1 * CTX) + 1, CTX, 100);
    expect(g).toHaveLength(2);
    expect(core.micFrames).toBe(2);
    core.clear(100);
    await expect(clipP).resolves.toEqual({ endCtxMs: 100 });
  });

  it("setMicSource subscribes and unsubscribes", () => {
    const { feeder } = feederOnClock();
    const cbs = new Set<(p: Int16Array) => void>();
    const mic: MicSource = { onFrame: (cb) => (cbs.add(cb), () => cbs.delete(cb)), stop: async () => undefined, energyDb: () => -40 };
    feeder.setMicSource(mic);
    expect(cbs.size).toBe(1);
    feeder.setMicSource(null);
    expect(cbs.size).toBe(0);
  });
});

describe("StreamingResampler (mic)", () => {
  const sine = (n: number, rate: number, hz: number) => Float32Array.from({ length: n }, (_, i) => 0.5 * Math.sin((2 * Math.PI * hz * i) / rate));

  it.each([
    [48_000, 16_000],
    [48_000, 24_000],
    [44_100, 16_000],
    [44_100, 24_000],
  ])("%i → %i: chunking-independent length, keeps a 440 Hz tone", (from, to) => {
    const x = sine(from, from, 440); // 1 s
    const a = new StreamingResampler(from, to);
    let n = 0;
    const parts: Int16Array[] = [];
    for (let off = 0; off < x.length; off += 882) {
      const y = a.push(x.subarray(off, off + 882));
      parts.push(y);
      n += y.length;
    }
    expect(Math.abs(n - to)).toBeLessThanOrEqual(40);
    const all = new Int16Array(n);
    let o = 0;
    for (const p of parts) {
      all.set(p, o);
      o += p.length;
    }
    const rms = Math.sqrt(all.subarray(200).reduce((s, v) => s + (v / 32768) ** 2, 0) / (n - 200));
    expect(rms).toBeGreaterThan(0.3);
    expect(rms).toBeLessThan(0.4);
  });

  it("attenuates content above the target Nyquist (44.1 k → 16 k, 10 kHz tone)", () => {
    const r = new StreamingResampler(44_100, 16_000);
    const y = r.push(sine(44_100, 44_100, 10_000));
    const rms = Math.sqrt(y.subarray(400).reduce((s, v) => s + (v / 32768) ** 2, 0) / (y.length - 400));
    expect(rms).toBeLessThan(0.03);
  });

  it("float32Db", () => {
    expect(float32Db(new Float32Array(10))).toBe(-120);
    expect(float32Db(new Float32Array(10).fill(0.5))).toBeCloseTo(-6.02, 1);
  });
});

describe("worklet sources", () => {
  it("mic capture posts ~20 ms Float32 batches of input channel 0", () => {
    const rig = loadWorklet(MIC_CAPTURE_WORKLET_SOURCE, MIC_CAPTURE_PROCESSOR, 48_000);
    const input = new Float32Array(QUANTUM).fill(0.25);
    rig.render(30, 1, () => [[input]]);
    const pcm = ofType(rig.posted, "pcm");
    expect(pcm.length).toBe(Math.floor((30 * QUANTUM) / 960));
    expect((pcm[0]!.samples as Float32Array).length).toBe(960);
    expect((pcm[0]!.samples as Float32Array)[5]).toBe(0.25);
    rig.node.port.postMessage({ type: "stop" });
    rig.render(1, 1, () => [[input]]);
    expect(rig.alive).toBe(false);
  });

  it("the combined module registers all four processors without name clashes", () => {
    const names: string[] = [];
    const scope = { AudioWorkletProcessor: class {}, registerProcessor: (n: string) => names.push(n), sampleRate: 48_000, currentTime: 0 };
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    new Function("__scope", `with (__scope) {\n${ALL_WORKLETS_SOURCE}\n}`)(scope);
    expect(names.sort()).toEqual(["baton-call-player", "baton-clock", "baton-mic-capture", "baton-va-output"]);
  });
});
