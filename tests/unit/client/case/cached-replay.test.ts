/**
 * Cached-turn replay (DESIGN §5.1.10, WP4 acceptance 5): finals emitted at recvMs ±50 ms on the CallPlayer clock,
 * cached turn ids + source stt_cache, the mode label, per-channel activation.
 * (Lives under tests/unit/client/case/ because WP4 owns that folder; the module is src/client/replay/cached-replay.ts.)
 */
import { describe, expect, it } from "vitest";
import { mulawEncode } from "../../../../src/core/audio";
import type { CachedTurnsFile } from "../../../../src/core/contracts/eval";
import { TurnInputSchema, type TurnInput } from "../../../../src/core/contracts/turns";
import { CallPlayer, type SpanAudioContext } from "../../../../src/client/audio/call-player";
import { CALL_PLAYER_PROCESSOR, CALL_PLAYER_WORKLET_SOURCE } from "../../../../src/client/audio/worklets/call-player.worklet";
import { CachedReplay } from "../../../../src/client/replay/cached-replay";
import { loadWorklet } from "../audio/worklet-harness";
import { Sink } from "../stt/fakes";

const CTX = 44_100;
const mk = (order: number, text: string, final: boolean, start: number, end: number) => ({
  type: "Turn", turn_order: order, turn_is_formatted: true, end_of_turn: final, transcript: text, end_of_turn_confidence: 0.9,
  words: text.split(" ").map((w, i, a) => ({ text: w, start: start + ((end - start) * i) / a.length, end: start + ((end - start) * (i + 1)) / a.length, confidence: 0.9, word_is_final: final })),
});

function file(): CachedTurnsFile {
  const rep: CachedTurnsFile["channels"]["rep"] = [];
  const customer: CachedTurnsFile["channels"]["customer"] = [];
  // 20 turns alternating, finals at irregular recvMs (not multiples of the 50 ms tick)
  for (let k = 0; k < 20; k++) {
    const start = 1000 + k * 2500;
    const end = start + 1800;
    const recv = end + 317 + (k % 7) * 13;
    const arr = k % 2 === 0 ? rep : customer;
    const order = Math.floor(k / 2);
    arr.push({ recvMs: start + 700, message: mk(order, "partial words", false, start, start + 600) });
    arr.push({ recvMs: recv, message: mk(order, `final turn number ${k}`, true, start, end) });
  }
  return { callId: "c1", variant: "pc_ctx", transcribedAt: "2026-09-25T11:00:00Z", channels: { rep, customer } };
}

function setup() {
  const sink = new Sink();
  const turns: TurnInput[] = [];
  const cr = new CachedReplay({ caseId: "case_1", sink, caseSync: { enqueue: (t) => turns.push(t) }, now: () => 0 });
  const rig = loadWorklet(CALL_PLAYER_WORKLET_SOURCE, CALL_PLAYER_PROCESSOR, CTX);
  const pcm = new Int16Array(8000 * 60);
  const player = new CallPlayer({
    ctx: { sampleRate: CTX, currentTime: 0, destination: {} } as unknown as SpanAudioContext,
    node: rig.node, duckGain: null, format: { encoding: "pcm_mulaw", sampleRate: 8000 }, srcBytes: { rep: mulawEncode(pcm), customer: mulawEncode(pcm) },
  });
  player.onTick((t) => cr.onTick(t.callMs));
  return { sink, turns, cr, rig, player, renderMs: (ms: number) => rig.render(Math.round((ms / 1000) * CTX / 128)) };
}

describe("CachedReplay", () => {
  it("emits every final within 0..50 ms after its recvMs on the call clock, with cached ids and the label", async () => {
    const s = setup();
    await s.cr.load(file());
    s.player.start(0);
    s.cr.activate("both", 0, "live transcription unavailable (replay-only mode)");
    s.renderMs(55_000);
    expect(s.turns).toHaveLength(20);
    for (const t of s.turns) expect(TurnInputSchema.safeParse(t).success).toBe(true);
    expect(s.turns[0]!.turnId).toBe("rep-c0");
    expect(s.turns[1]!.turnId).toBe("customer-c0");
    expect(s.turns.every((t) => t.source === "stt_cache")).toBe(true);
    const lags = s.cr.emissions.map((e) => e.emittedAtMs - e.recvMs);
    expect(Math.min(...lags)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...lags)).toBeLessThanOrEqual(50 + (128 / CTX) * 1000);
    // recvMs is the ORIGINAL arrival time, not the emission time
    expect(s.turns[0]!.recvMs).toBe(file().channels.rep[1]!.recvMs);
    expect(s.sink.of("mode")).toEqual([{ t: 0, type: "mode", mode: "cached_replay", reason: "live transcription unavailable (replay-only mode)" }]);
    expect(s.sink.of("fallback")[0]!.label).toMatch(/^CACHED REPLAY: .*Transcribed live by AssemblyAI on 2026-09-25; replayed now\.$/);
    expect(s.sink.of("stt.partial").length).toBe(20);
  });

  it("per-channel activation from a call ms skips earlier records (partially cached); label emitted once", async () => {
    const s = setup();
    await s.cr.load(file());
    s.player.start(0);
    s.renderMs(10_000);
    expect(s.turns).toHaveLength(0);
    s.cr.activate("customer", 10_000, "partially cached");
    s.cr.activate("customer", 12_000, "again");
    s.renderMs(10_000);
    expect(s.turns.every((t) => t.channel === "customer")).toBe(true);
    expect(s.turns.every((t) => t.recvMs >= 10_000)).toBe(true);
    expect(s.turns.length).toBe(2); // customer finals every 5 s in 10..20 s
    expect(s.sink.of("mode")).toHaveLength(1);
    s.cr.deactivate("customer");
    const n = s.turns.length;
    s.renderMs(10_000);
    expect(s.turns.length).toBe(n);
  });

  it("ensureLoaded fetches the url once; rejects without one", async () => {
    let calls = 0;
    const fetchImpl = (async () => (calls++, new Response(JSON.stringify(file())))) as unknown as typeof fetch;
    const cr = new CachedReplay({ caseId: "c", sink: new Sink(), caseSync: { enqueue() {} }, now: () => 0, fetchImpl, url: "/data/cached-turns/c1.json" });
    await cr.ensureLoaded();
    await cr.ensureLoaded();
    expect(calls).toBe(1);
    expect(cr.transcribedAt).toBe("2026-09-25T11:00:00Z");
    const none = new CachedReplay({ caseId: "c", sink: new Sink(), caseSync: { enqueue() {} }, now: () => 0 });
    await expect(none.ensureLoaded()).rejects.toThrow(/no cached turns/);
  });
});
