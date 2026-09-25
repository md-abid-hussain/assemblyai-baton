import { describe, expect, it } from "vitest";

import type { Evidence } from "@/core/contracts/case";
import { clipWindow } from "@/client/session/clip-window";
import { clipWindowFor, createEvidencePlayer, DUCK_LEVEL } from "@/client/session/evidence";

const words = [
  { startMs: 1000, endMs: 1400 },
  { startMs: 1500, endMs: 1900 },
  { startMs: 2000, endMs: 2400 },
  { startMs: 2500, endMs: 3000 },
];
const turn = { words, startMs: 1000, endMs: 3000 };

describe("clipWindow (DESIGN §5.11; mirrors WP1's src/core/evidence/clip.ts)", () => {
  it("pads only inner edges for streaming words", () => {
    expect(clipWindow({ startMs: 1500, endMs: 2400 }, turn, "stream", 60_000)).toEqual({ fromMs: 1100, toMs: 2700 });
    // quote at the turn's first and last word: no padding, but the 1500 ms minimum applies
    expect(clipWindow({ startMs: 1000, endMs: 3000 }, turn, "stream", 60_000)).toEqual({ fromMs: 1000, toMs: 3000 });
  });
  it("pads 300 ms both sides for async words, clamps to the call and enforces 1.5–8 s", () => {
    expect(clipWindow({ startMs: 5000, endMs: 6000 }, turn, "async", 60_000)).toEqual({ fromMs: 4700, toMs: 6300 });
    expect(clipWindow({ startMs: 100, endMs: 300 }, turn, "async", 60_000)).toEqual({ fromMs: 0, toMs: 1500 });
    expect(clipWindow({ startMs: 59_800, endMs: 59_900 }, turn, "async", 60_000)).toEqual({ fromMs: 58_500, toMs: 60_000 });
    expect(clipWindow({ startMs: 1000, endMs: 20_000 }, turn, "async", 60_000)).toEqual({ fromMs: 700, toMs: 8700 });
  });
});

describe("evidence chips play the padded window and duck the call (WP7 acceptance 3)", () => {
  const ev: Evidence = { channel: "customer", turnId: "customer-2", startMs: 1500, endMs: 2400, quote: "March 14th", source: "stt_live" };

  it("duck(0.2) → playSpan(channel, clipWindow) → duck(1)", async () => {
    const calls: string[] = [];
    const playback = {
      duck: (v: number) => void calls.push(`duck ${v}`),
      playSpan: async (ch: string, from: number, to: number) => void calls.push(`play ${ch} ${from} ${to}`),
    };
    const play = createEvidencePlayer({ playback, durationMs: 60_000, turnOf: (id) => (id === "customer-2" ? turn : null) });
    const w = await play(ev);
    expect(w).toEqual({ fromMs: 1100, toMs: 2700 });
    expect(calls).toEqual([`duck ${DUCK_LEVEL}`, "play customer 1100 2700", "duck 1"]);
  });

  it("restores the volume even if the clip fails, and AI-half chips go to the injected player", async () => {
    const calls: string[] = [];
    const playback = {
      duck: (v: number) => void calls.push(`duck ${v}`),
      playSpan: async () => {
        throw new Error("decode");
      },
    };
    const aiCalls: unknown[] = [];
    const play = createEvidencePlayer({ playback, durationMs: 60_000, turnOf: () => null, playAiClip: async (e, w) => void aiCalls.push([e.turnId, w]) });
    await expect(play(ev)).rejects.toThrow("decode");
    expect(calls).toEqual(["duck 0.2", "duck 1"]);
    await play({ ...ev, channel: "ai", source: "async_ch2", turnId: "ai-3", startMs: 4000, endMs: 5000 });
    expect(aiCalls).toEqual([["ai-3", { fromMs: 3700, toMs: 5300 }]]);
    expect(clipWindowFor({ ...ev, source: "async_ch2" }, null, 60_000)).toEqual({ fromMs: 1200, toMs: 2700 });
  });
});
