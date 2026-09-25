/**
 * The $0 loopback sessions used by /dev/audio and the browser checks: they reject what the server would (3007) and
 * replay cached Turn messages on the session clock through the real manager.
 */
import { describe, expect, it } from "vitest";
import { buildSttParams } from "../../../../src/core/aai/stt-params";
import type { CachedTurnsFile } from "../../../../src/core/contracts/eval";
import type { TurnInput } from "../../../../src/core/contracts/turns";
import { LiveSttChannelManager } from "../../../../src/client/stt/channel-manager";
import { LoopbackSession, loopbackStt } from "../../../../src/client/stt/loopback";
import { call as call8k, policy } from "../../contracts/fixtures";
import { Sink } from "./fakes";

const params = { rep: buildSttParams(call8k, policy, "rep"), customer: buildSttParams(call8k, policy, "customer") };

describe("LoopbackSession", () => {
  it("accepts 50..1000 ms frames and closes with 3007 otherwise (like the server)", () => {
    const s = new LoopbackSession(params.rep, "lb");
    const closes: number[] = [];
    s.on("close", (e: { code: number }) => closes.push(e.code));
    expect(s.sendAudio(new Uint8Array(800))).toBe(true);
    expect(s.audioMs).toBe(100);
    expect(s.sendAudio(new Uint8Array(160))).toBe(false); // 20 ms
    expect(closes).toEqual([3007]);
    expect(s.rejected).toBe(1);
  });

  it("drives the manager: cached turns come out as live turn ids on the call clock, Express offset respected", async () => {
    const mk = (order: number, text: string, final: boolean, start: number, end: number) => ({
      type: "Turn", turn_order: order, turn_is_formatted: true, end_of_turn: final, transcript: text, end_of_turn_confidence: 0.9,
      words: [{ text, start, end, confidence: 0.9, word_is_final: final }],
    });
    const file: CachedTurnsFile = {
      callId: "c", variant: "pc_ctx", transcribedAt: "2026-09-25",
      channels: { rep: [{ recvMs: 1200, message: mk(0, "early", true, 100, 900) }, { recvMs: 5600, message: mk(1, "later", true, 4200, 5100) }], customer: [] },
    };
    const lb = loopbackStt(params, file, 3000);
    const turns: TurnInput[] = [];
    const m = new LiveSttChannelManager({ api: lb.api, connect: lb.connect, sink: new Sink(), caseSync: { enqueue: (t) => turns.push(t) }, now: () => 0, strictBegin: false });
    await m.open({ caseId: "c1", caseToken: "-", runId: "r", call: call8k, policy, startOffsetMs: 3000, ctxCarry: "last_rep_turn" });
    // feed 3 s of 8 kHz µ-law from call ms 3000 in 100 ms ticks
    for (let k = 1; k <= 30; k++) m.feed({ callMs: 3000 + k * 100, playing: true, rep: new Uint8Array(800), customer: new Uint8Array(800) });
    expect(turns.map((t) => t.turnId)).toEqual(["rep-1"]);
    expect(turns[0]!.startMs).toBeCloseTo(4200, 6);
    expect(turns[0]!.endMs).toBeCloseTo(5100, 6);
    expect(turns[0]!.recvMs).toBeCloseTo(5600, 6);
    expect(lb.reports.filter((r) => r.event === "opened")).toHaveLength(2);
  });
});
