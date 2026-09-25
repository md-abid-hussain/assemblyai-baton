import { describe, expect, it } from "vitest";

import type { SttCacheRecord } from "../../../../src/core/contracts/eval";
import { TurnInputSchema } from "../../../../src/core/contracts/turns";
import { activityFromPeaks, buildPeaks, computePeaks } from "../../../../src/core/scenario/peaks";
import { cachedTurnsFileOf, finalsOf, isCompleteCache, majoritySpeaker, mapSpeakersToRoles, monoTurnInputs, perChannelTurnInputs } from "../../../../src/core/scenario/stt-cache";
import { fakeCache, turn } from "./helpers";

const rec = (channel: SttCacheRecord["channel"], recvMs: number, message: Record<string, unknown>): SttCacheRecord => ({ callId: "c", variant: "mono_diar", channel, recvMs, message });

describe("STT cache readers", () => {
  it("finals: first non-empty final per turn_order wins (duplicate and empty finals ignored), in recvMs order", async () => {
    const r = await fakeCache(
      "c",
      "pc_ctx",
      6000,
      [
        { atMs: 1000, msg: turn(0, "one two", true, 100, 900) },
        { atMs: 1200, msg: turn(0, "one two three", true, 100, 1100) },
        { atMs: 2000, msg: turn(1, "", true, 1500, 1500) },
        { atMs: 4000, msg: turn(2, "later", true, 3500, 3900) },
      ],
      [{ atMs: 2500, msg: turn(0, "reply", true, 2000, 2400) }],
    );
    expect(finalsOf(r.records, "rep").map((f) => f.turn.transcript)).toEqual(["one two", "later"]);
    const turns = perChannelTurnInputs(r.records, "case-1");
    expect(turns.map((t) => [t.turnId, t.recvMs])).toEqual([["rep-c0", 1000], ["customer-c0", 2500], ["rep-c2", 4000]]);
    for (const t of turns) expect(TurnInputSchema.safeParse(t).success).toBe(true);
    expect(turns[0]).toMatchObject({ source: "stt_cache", startMs: 100, endMs: 900, cut: false, late: false });
    const file = cachedTurnsFileOf("c", r.records);
    expect(file.channels.rep.every((x) => x.message["type"] === "Turn")).toBe(true);
    expect(file.channels.rep).toHaveLength(4);
  });

  it("an incomplete cache (no trailer) is detected and refused for cached turns", async () => {
    const r = await fakeCache("c", "pc_ctx", 2000, [], []);
    const cut = r.records.filter((x) => x.message["type"] !== "BatonCacheMeta" || x.channel === "rep");
    expect(isCompleteCache(cut, "pc_ctx")).toBe(false);
    expect(() => cachedTurnsFileOf("c", cut.filter((x) => x.message["type"] !== "BatonCacheMeta"))).toThrow(/no BatonCacheMeta/);
  });

  it("mono_diar: speakers map to roles by overlap with per-channel activity; turns keep unique cached ids", () => {
    // rep speaks 0-1 s and 2-3 s; customer 1-2 s. Diarization: "A" = rep, "B" = customer.
    const rate = 8000;
    const tone = (ranges: [number, number][]) => {
      const x = new Int16Array(rate * 4);
      for (const [a, b] of ranges) for (let i = a * rate; i < b * rate; i++) x[i] = i % 2 ? 8000 : -8000;
      return x;
    };
    const peaks = buildPeaks(tone([[0, 1], [2, 3]]), tone([[1, 2]]), rate);
    const activity = { rep: activityFromPeaks(peaks.rep), customer: activityFromPeaks(peaks.customer) };
    const records = [
      rec("mono", 1100, turn(0, "hello this is Dan", true, 50, 950, "A")),
      rec("mono", 2100, turn(1, "hi I need help", true, 1050, 1950, "B")),
      rec("mono", 3100, { ...turn(2, "sure what is", true, 2050, 2950, "A"), words: [...(turn(2, "sure what is", true, 2050, 2950, "A").words as object[]).slice(0, 2), { text: "is", start: 2700, end: 2950, confidence: 1, word_is_final: true, speaker: "B" }] }),
    ];
    const attribution = mapSpeakersToRoles(finalsOf(records, "mono"), activity);
    expect(attribution.mapping).toEqual({ A: "rep", B: "customer" });
    expect(majoritySpeaker(finalsOf(records, "mono")[2]!.turn)).toBe("A");
    const { turns, unattributed } = monoTurnInputs(records, activity, "case");
    expect(unattributed).toBe(0);
    expect(turns.map((t) => `${t.turnId}:${t.channel}`)).toEqual(["rep-c0:rep", "customer-c1:customer", "rep-c2:rep"]);
  });

  it("peaks: 50 windows per second, 0..1, max-abs", () => {
    const x = new Int16Array(8000).fill(0);
    x[100] = -32768;
    const p = computePeaks(x, 8000);
    expect(p).toHaveLength(50);
    expect(p[0]).toBe(1);
    expect(p[1]).toBe(0);
  });
});
