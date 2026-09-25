/**
 * Express start (DESIGN §5.1.6): decisionPoint − 25 s, snapped BACK to the cut with the fewest cached finals in
 * flight (prefill = cached finals with recvMs ≤ p, live from p, so an in-flight final would be split); seed = the
 * last cached rep final before the cut. Uses the fixture recorded live plus a synthetic call with real pauses.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { CachedTurnsFile } from "../../../../src/core/contracts/eval";
import type { Peaks } from "../../../../src/core/contracts/scenario";
import { cachedFinals, expressStart, inFlightAt, lastRepFinalBefore, silenceGapPoints } from "../../../../src/client/stt/express";

const fixture = (f: string) => JSON.parse(readFileSync(new URL(`../../../../public/fixtures/dialog/${f}`, import.meta.url), "utf8")) as unknown;
const cached = fixture("cached-turns.8k.json") as CachedTurnsFile;
const peaks = fixture("peaks.8k.json") as Peaks;

/** A call with 1.5 s pauses between turns: turn k on channel k%2, speech [k·5 s, k·5 s + 3.5 s]. */
function synthetic(): { file: CachedTurnsFile; peaks: Peaks } {
  const rep: CachedTurnsFile["channels"]["rep"] = [];
  const customer: CachedTurnsFile["channels"]["customer"] = [];
  const n = 50 * 60;
  const pk = { ratePerSec: 50 as const, rep: new Array<number>(n).fill(0), customer: new Array<number>(n).fill(0) };
  for (let k = 0; k < 11; k++) {
    const s = k * 5000;
    const e = s + 3500;
    const ch = k % 2 === 0 ? "rep" : "customer";
    for (let i = Math.floor(s / 20); i < Math.floor(e / 20); i++) pk[ch][i] = 0.4;
    const msg = { type: "Turn", turn_order: Math.floor(k / 2), end_of_turn: true, transcript: `turn ${k}`, words: [{ start: s - 800, end: e + 400 }] };
    (ch === "rep" ? rep : customer).push({ recvMs: e + 450, message: msg });
  }
  return { file: { callId: "syn", variant: "pc_ctx", transcribedAt: "2026-09-25", channels: { rep, customer } }, peaks: pk };
}

describe("expressStart", () => {
  it("no decision point / early decision → full start", () => {
    expect(expressStart({ decisionPointMs: null }, cached, peaks)).toMatchObject({ startOffsetMs: 0, snappedTo: "full" });
    expect(expressStart({ decisionPointMs: 20_000 }, cached, peaks)).toMatchObject({ startOffsetMs: 0, snappedTo: "full" });
  });

  it.each([30_000, 41_000, 47_000, 52_600])("real pauses (decision %i): a CLEAN cut in a joint silence, nothing lost, seed = last rep final", (dp) => {
    const { file, peaks: pk } = synthetic();
    const r = expressStart({ decisionPointMs: dp }, file, pk);
    // the gap middle can be "in flight" because the next turn's first word time is 0.8 s early: then the final's
    // arrival (inside the same pause) is the newest clean cut
    expect(["silence", "turn_boundary"]).toContain(r.snappedTo);
    expect(r.inFlight).toBe(0);
    expect(r.startOffsetMs).toBeLessThanOrEqual(r.targetMs);
    expect(r.targetMs - r.startOffsetMs).toBeLessThan(5_000);
    for (const f of cachedFinals(file)) expect(f.recvMs <= r.startOffsetMs || f.firstWordMs >= r.startOffsetMs).toBe(true);
    expect(r.seedAgentContext).toBe(lastRepFinalBefore(file, r.startOffsetMs));
    const i = Math.round(r.startOffsetMs / 20);
    expect(Math.max(pk.rep[i]!, pk.customer[i]!)).toBe(0);
  });

  it("the tight TTS fixture (250 ms gaps): the cut with the fewest in-flight finals, newest first", () => {
    const r = expressStart({ decisionPointMs: 46_270 }, cached, peaks);
    expect(r.startOffsetMs).toBeLessThanOrEqual(21_270);
    expect(r.startOffsetMs).toBeGreaterThanOrEqual(21_270 - 15_000);
    const finals = cachedFinals(cached);
    expect(r.inFlight).toBe(inFlightAt(finals, r.startOffsetMs));
    // no candidate in the window has fewer finals in flight
    for (let p = 6_270; p <= 21_270; p += 20) {
      const quiet = Math.max(peaks.rep[Math.round(p / 20)] ?? 1, peaks.customer[Math.round(p / 20)] ?? 1) < 0.02;
      if (quiet) expect(inFlightAt(finals, p)).toBeGreaterThanOrEqual(r.inFlight);
    }
    expect(r.seedAgentContext).toBe(lastRepFinalBefore(cached, r.startOffsetMs));
  });

  it("without cached turns: the newest joint silence gap; without anything: the target, unsnapped", () => {
    const r = expressStart({ decisionPointMs: 46_270 }, null, peaks);
    expect(r.snappedTo).toBe("silence");
    const i = Math.round(r.startOffsetMs / 20);
    expect(Math.max(peaks.rep[i] ?? 0, peaks.customer[i] ?? 0)).toBeLessThan(0.02);
    expect(expressStart({ decisionPointMs: 46_270 }, null, null)).toMatchObject({ startOffsetMs: 21_270, snappedTo: "unsnapped", seedAgentContext: null });
  });

  it("silenceGapPoints: ≥ 200 ms of JOINT silence, middle of the gap", () => {
    expect(silenceGapPoints({ ratePerSec: 50, rep: [0.5, 0, 0, 0, 0.5], customer: [0, 0, 0, 0, 0] })).toEqual([]); // 60 ms
    const rep = [0.5, ...new Array(20).fill(0), 0.5];
    expect(silenceGapPoints({ ratePerSec: 50, rep, customer: new Array(rep.length).fill(0) })).toEqual([220]);
    const cus = new Array(rep.length).fill(0);
    cus[7] = 0.3;
    cus[14] = 0.3; // the customer speaks inside the rep's pause: no 200 ms joint silence
    expect(silenceGapPoints({ ratePerSec: 50, rep, customer: cus })).toEqual([]);
  });
});
