import { describe, expect, it } from "vitest";
import { CLIP_MAX_MS, CLIP_MIN_MS, clipWindow } from "../../../../src/core/evidence/clip";

const words = [
  { startMs: 10_000, endMs: 10_400 }, { startMs: 10_500, endMs: 11_000 }, { startMs: 11_100, endMs: 11_600 },
  { startMs: 11_700, endMs: 12_200 }, { startMs: 12_300, endMs: 13_000 },
];
const turn = { words, startMs: 10_000, endMs: 13_000 };

describe("clipWindow (DESIGN §5.11)", () => {
  it("streaming: no padding on the turn's own edge words, 400/300 ms inside", () => {
    expect(clipWindow({ startMs: 10_000, endMs: 13_000 }, turn, "stream", 60_000)).toEqual({ fromMs: 10_000, toMs: 13_000 });
    expect(clipWindow({ startMs: 10_500, endMs: 12_200 }, turn, "stream", 60_000)).toEqual({ fromMs: 10_100, toMs: 12_500 });
    expect(clipWindow({ startMs: 10_000, endMs: 12_200 }, turn, "stream", 60_000)).toEqual({ fromMs: 10_000, toMs: 12_500 });
    expect(clipWindow({ startMs: 11_100, endMs: 13_000 }, turn, "stream", 60_000)).toEqual({ fromMs: 10_700, toMs: 13_000 });
  });
  it("async: 300 ms both sides", () => {
    expect(clipWindow({ startMs: 5_000, endMs: 7_000 }, { words: [], startMs: 4_000, endMs: 8_000 }, "async", 60_000)).toEqual({ fromMs: 4_700, toMs: 7_300 });
  });
  it("minimum 1500 ms, extended equally, shifted inside [0, duration]", () => {
    const short = clipWindow({ startMs: 11_100, endMs: 11_600 }, turn, "stream", 60_000);
    expect(short.toMs - short.fromMs).toBe(CLIP_MIN_MS);
    expect(short).toEqual({ fromMs: 10_550, toMs: 12_050 }); // 10 700–11 900 padded, then +150 each side
    expect(clipWindow({ startMs: 100, endMs: 200 }, { words: [], startMs: 100, endMs: 200 }, "async", 60_000)).toEqual({ fromMs: 0, toMs: 1_500 });
    expect(clipWindow({ startMs: 59_800, endMs: 59_900 }, { words: [], startMs: 59_000, endMs: 59_950 }, "async", 60_000)).toEqual({ fromMs: 58_500, toMs: 60_000 });
    expect(clipWindow({ startMs: 100, endMs: 200 }, { words: [], startMs: 0, endMs: 500 }, "async", 1_000)).toEqual({ fromMs: 0, toMs: 1_000 });
  });
  it("capped at 8000 ms keeping the start; clamped to the recording", () => {
    const long = clipWindow({ startMs: 1_000, endMs: 20_000 }, { words: [], startMs: 1_000, endMs: 20_000 }, "stream", 60_000);
    expect(long).toEqual({ fromMs: 1_000, toMs: 1_000 + CLIP_MAX_MS });
    expect(clipWindow({ startMs: 70_000, endMs: 71_000 }, { words: [], startMs: 0, endMs: 0 }, "async", 60_000)).toEqual({ fromMs: 58_500, toMs: 60_000 });
  });
});
