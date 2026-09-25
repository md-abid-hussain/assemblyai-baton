/**
 * VaOutputPlayer (DESIGN §5.9.3): the real worklet source + the main-thread wrapper. Start threshold 120 ms / 200 ms
 * timeout, holdUntil, first-audible timing, adaptive underruns, flush, 24 kHz → 48 kHz resampling, leading-silence drop.
 */
import { describe, expect, it } from "vitest";
import { pcm16ToBase64 } from "../../../../src/core/audio";
import { slowUplink, VaOutput } from "../../../../src/client/audio/va-output";
import { VA_OUTPUT_PROCESSOR, VA_OUTPUT_WORKLET_SOURCE } from "../../../../src/client/audio/worklets/va-output.worklet";
import { loadWorklet, ofType, QUANTUM } from "./worklet-harness";

const CTX = 48_000;
const ms24 = (ms: number, v = 8000) => new Int16Array((24_000 * ms) / 1000).fill(v);
const b64 = (ms: number, v = 8000) => pcm16ToBase64(ms24(ms, v));

function setup() {
  const rig = loadWorklet(VA_OUTPUT_WORKLET_SOURCE, VA_OUTPUT_PROCESSOR, CTX);
  const out = new VaOutput({ node: rig.node, gain: null, now: () => rig.currentTime });
  const first: { replyId: string; ms: number }[] = [];
  out.onFirstAudiblePlayed((replyId, ms) => first.push({ replyId, ms }));
  const nonZeroAt = (L: Float32Array) => L.findIndex((v) => v !== 0);
  return { rig, out, first, nonZeroAt };
}

describe("VaOutput worklet", () => {
  it("drops leading-silence chunks (audible=false) and never plays them", () => {
    const { rig, out } = setup();
    out.push(b64(100, 0), "r1", false);
    out.push(b64(100, 0), "r1", false);
    expect(out.droppedLeading).toBe(2);
    const [L] = rig.render(50, 1);
    expect(L!.every((v) => v === 0)).toBe(true);
  });

  it("starts at once with ≥120 ms buffered; reports first audible at the rendered sample's ctx time", () => {
    const { rig, out, first, nonZeroAt } = setup();
    rig.render(3, 1);
    const t0 = rig.currentTime;
    out.push(b64(150), "r1", true);
    const [L] = rig.render(20, 1);
    expect(nonZeroAt(L!)).toBe(0);
    expect(first).toEqual([{ replyId: "r1", ms: t0 * 1000 }]);
  });

  it("with < 120 ms buffered waits 200 ms (ctx time) after the first kept chunk", () => {
    const { rig, out, nonZeroAt } = setup();
    out.push(b64(60), "r1", true);
    const [L] = rig.render(100, 1); // 266 ms
    const start = nonZeroAt(L!);
    expect(start).toBeGreaterThanOrEqual(Math.floor((0.2 * CTX) / QUANTUM) * QUANTUM);
    expect(start).toBeLessThanOrEqual(Math.ceil((0.2 * CTX) / QUANTUM) * QUANTUM + QUANTUM);
  });

  it("holdUntil: no output before t even with plenty buffered; the backlog is kept", () => {
    const { rig, out, first, nonZeroAt } = setup();
    out.holdUntil(500);
    out.push(b64(400), "g", true);
    const [L] = rig.render(400, 1); // 1067 ms
    const start = nonZeroAt(L!);
    expect(start / CTX).toBeGreaterThanOrEqual(0.5);
    expect(start / CTX).toBeLessThan(0.5 + QUANTUM / CTX + 1e-9);
    expect(first[0]!.ms).toBeGreaterThanOrEqual(500);
    // 400 ms of audio played in full (backlog kept): non-zero samples ≈ 400 ms × 48 kHz
    const played = L!.filter((v) => v !== 0).length;
    expect(played).toBeGreaterThan(0.39 * CTX);
  });

  it("resamples 24 kHz → 48 kHz: 100 ms in → 100 ms out", () => {
    const { rig, out } = setup();
    out.push(b64(200), "r", true);
    const [L] = rig.render(150, 1); // 400 ms
    const played = L!.filter((v) => v !== 0).length;
    expect(Math.abs(played - 0.2 * CTX)).toBeLessThanOrEqual(QUANTUM);
  });

  it("underrun = dry then more audio of the SAME reply → counted, threshold +80 ms; a new reply is not an underrun", () => {
    const { rig, out } = setup();
    out.push(b64(150), "r1", true);
    rig.render(100, 1); // plays out, runs dry
    out.push(b64(150), "r2", true); // new reply: not an underrun
    rig.render(100, 1);
    expect(out.underruns).toBe(0);
    out.push(b64(150), "r2", true); // same reply after dry: underrun
    expect(out.underruns).toBe(1);
    expect(out.startThresholdMs).toBe(200);
    rig.render(100, 1);
    for (let i = 0; i < 5; i++) {
      out.push(b64(20), "r2", true);
      rig.render(100, 1);
    }
    expect(out.startThresholdMs).toBe(400); // capped
    expect(ofType(rig.posted, "underrun").length).toBe(out.underruns);
  });

  it("flush empties the buffer (idempotent) and posts flushed", () => {
    const { rig, out } = setup();
    out.push(b64(500), "r1", true);
    rig.render(10, 1);
    out.flush();
    out.flush();
    const [L] = rig.render(50, 1);
    expect(L!.every((v) => v === 0)).toBe(true);
    expect(out.flushes).toBe(2);
  });

  it("first audible is reported once per reply, when ITS first sample plays", () => {
    const { rig, out, first } = setup();
    out.push(b64(150), "a", true);
    out.push(b64(100), "a", true);
    out.push(b64(100), "b", true);
    rig.render(200, 1);
    expect(first.map((f) => f.replyId)).toEqual(["a", "b"]);
    expect(first[1]!.ms - first[0]!.ms).toBeCloseTo(250, 0);
  });

  it("slowUplink badge threshold (~1 s of outgoing audio)", () => {
    expect(slowUplink(10_000)).toBe(false);
    expect(slowUplink(70_000)).toBe(true);
  });
});
