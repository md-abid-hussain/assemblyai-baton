import { describe, expect, it } from "vitest";

import { SttCacheRecordSchema } from "../../../../src/core/contracts/eval";
import { STT_CACHE_META_TYPE } from "../../../../src/core/contracts/ext/wp9-data";
import { mulawDecodeSample, mulawEncodeSample } from "../../../../src/core/audio/mulaw";
import { cacheMeta, isCompleteCache, parseSttCacheJsonl, serializeSttCacheRecord } from "../../../../src/core/scenario/stt-cache";
import { downmixUlaw, estimateSttUsd, paramsHashOf, runSttCache, SttRunError } from "../../../../src/core/scenario/stt-run";
import { fakeCache, FakeSession, opened, turn } from "./helpers";

const REP = [
  { atMs: 900, msg: turn(0, "hi this is", false, 100, 800) },
  { atMs: 1500, msg: turn(0, "hi this is Daniel", true, 100, 1100) },
  { atMs: 1600, msg: turn(0, "hi this is Daniel", true, 100, 1100) }, // duplicate final
  { atMs: 4000, msg: turn(1, "what is her date of birth", true, 3000, 3700) },
];
const CUSTOMER = [{ atMs: 2600, msg: turn(0, "hello", true, 1900, 2300) }];

describe("runSttCache", () => {
  it("pc_ctx: records every message at the audio ms sent, carries rep finals to the customer once each, ends with trailers", async () => {
    const r = await fakeCache("s01_T", "pc_ctx", 5000, REP, CUSTOMER);
    expect(r.customer.updates).toEqual(["hi this is Daniel", "what is her date of birth"]);
    expect(r.agentContextUpdates).toBe(2);
    expect(r.rep.updates).toEqual([]);
    for (const rec of r.records) expect(SttCacheRecordSchema.safeParse(rec).success).toBe(true);
    // Begin at 0; turns at the first frame boundary at/after their scripted time; Termination at the end.
    const rep = r.records.filter((x) => x.channel === "rep");
    expect(rep[0]!.message["type"]).toBe("Begin");
    expect(rep[0]!.recvMs).toBe(0);
    const firstFinal = rep.find((x) => x.message["type"] === "Turn" && x.message["end_of_turn"] === true)!;
    expect(firstFinal.recvMs).toBe(1500);
    const recv = rep.map((x) => x.recvMs);
    expect(recv).toEqual([...recv].sort((a, b) => a - b));
    // 5000 ms audio + 1500 ms tail silence, 100 ms frames.
    expect(r.audioMs).toBe(6500);
    expect(r.rep.sent.every((b) => b === 800)).toBe(true);
    const meta = cacheMeta(r.records);
    expect(meta.rep?.billedSeconds).toBe(7);
    expect(meta.customer?.agentContextUpdates).toBe(2);
    expect(meta.rep?.paramsHash).toBe(paramsHashOf({ speech_model: "universal-3-5-pro" }));
    expect(isCompleteCache(r.records, "pc_ctx")).toBe(true);
    expect(r.records.at(-1)!.message["type"]).toBe(STT_CACHE_META_TYPE);
  });

  it("pc_noctx never sends agent_context", async () => {
    const r = await fakeCache("s01_T", "pc_noctx", 5000, REP, CUSTOMER);
    expect(r.customer.updates).toEqual([]);
    expect(r.agentContextUpdates).toBe(0);
  });

  it("paces at the requested speed (sleeps until each frame's audio exists)", async () => {
    let clock = 0;
    const slept: number[] = [];
    const a = new FakeSession([]);
    const b = new FakeSession([]);
    await runSttCache(
      { callId: "x", variant: "pc_noctx", audio: { rep: new Uint8Array(8000), customer: new Uint8Array(8000) }, ctxCarry: "none", speed: 2, tailSilenceMs: 0 },
      { open: async () => ({ rep: opened(a), customer: opened(b) }), now: () => clock, sleep: async (ms) => { slept.push(ms); clock += ms; }, isoNow: () => "t" },
    );
    expect(slept.reduce((s, x) => s + x, 0)).toBeCloseTo(500, 5); // 1 s of audio at 2×
  });

  it("a session that closes mid-call aborts the run (no trailers, SttRunError) and still terminates both", async () => {
    const a = new FakeSession([], 1000);
    const b = new FakeSession([]);
    let clock = 0;
    await expect(
      runSttCache(
        { callId: "x", variant: "pc_ctx", audio: { rep: new Uint8Array(40_000), customer: new Uint8Array(40_000) }, ctxCarry: "last_rep_turn" },
        { open: async () => ({ rep: opened(a), customer: opened(b) }), now: () => clock, sleep: async (ms) => void (clock += ms), isoNow: () => "t" },
      ),
    ).rejects.toBeInstanceOf(SttRunError);
    expect(b.closed).toBe(true);
  });

  it("mono: one session, one trailer", async () => {
    const m = new FakeSession([{ atMs: 500, msg: turn(0, "hello there", true, 0, 400, "A") }]);
    let clock = 0;
    const r = await runSttCache(
      { callId: "x", variant: "mono_diar", audio: { mono: new Uint8Array(8000).fill(0xff) }, ctxCarry: "none" },
      { open: async () => ({ mono: opened(m) }), now: () => clock, sleep: async (ms) => void (clock += ms), isoNow: () => "t" },
    );
    expect(isCompleteCache(r.records, "mono_diar")).toBe(true);
    expect(new Set(r.records.map((x) => x.channel))).toEqual(new Set(["mono"]));
  });

  it("JSONL round-trips and malformed lines fail with the line number", async () => {
    const r = await fakeCache("s01_T", "pc_ctx", 3000, REP, CUSTOMER);
    const text = `${r.records.map(serializeSttCacheRecord).join("\n")}\n`;
    expect(parseSttCacheJsonl(text)).toEqual(r.records);
    expect(() => parseSttCacheJsonl(`${text}{bad\n`, "f")).toThrow(/f:\d+: not JSON/);
  });

  it("downmix and cost estimate", () => {
    const silence = new Uint8Array(4).fill(0xff);
    expect([...downmixUlaw(silence, silence, mulawDecodeSample, mulawEncodeSample)].every((b) => mulawDecodeSample(b) === 0)).toBe(true);
    expect(estimateSttUsd("pc_ctx", 118_500)).toBeCloseTo(2 * (120 / 3600) * 0.5, 6);
    expect(estimateSttUsd("mono_diar", 118_500)).toBeCloseTo((120 / 3600) * 0.62, 6);
  });
});
