import { createHash } from "node:crypto";

import type OpenAI from "openai";
import { describe, expect, it } from "vitest";

import { BatonError } from "@/core/contracts/errors";
import { MemoryTtsCache } from "@/server/sim/tts-cache";
import { normalizeTtsText, TTS_MODEL, TTS_USD_PER_CHAR, TTS_USD_PER_REQUEST, ttsCostUsd, ttsHash, TtsService, type TtsDeps } from "@/server/openai/tts";
import { fakeLedger, fakeSpeak, tone24k } from "./helpers";

const client = {} as OpenAI;

function service(o: Partial<TtsDeps> = {}) {
  const ledger = fakeLedger();
  const cache = new MemoryTtsCache();
  const log: { input: string; voice: string; instructions: string; model: string }[] = [];
  const tts = new TtsService({ openai: () => client, cache, ledger: () => ledger, env: () => "dev-wp17", speak: fakeSpeak({ log }), ...o });
  return { tts, ledger, cache, log };
}

const req = (text: string, voice = "marin") => ({ text, voice, instructions: "calm", refId: "sim_test" });

describe("TTS module (PLATFORM §7.5 step 2)", () => {
  it("pins gpt-4o-mini-tts-2025-12-15 and hashes model|voice|instructions|text", () => {
    expect(TTS_MODEL).toBe("gpt-4o-mini-tts-2025-12-15");
    const want = createHash("sha256").update("gpt-4o-mini-tts-2025-12-15|marin|calm|Hi there.").digest("hex");
    expect(ttsHash(TTS_MODEL, "marin", "calm", "Hi there.")).toBe(want);
    expect(ttsHash(TTS_MODEL, "cedar", "calm", "Hi there.")).not.toBe(want);
    expect(ttsHash(TTS_MODEL, "marin", "warm", "Hi there.")).not.toBe(want);
  });

  it("settles from the character count (per request + per char)", () => {
    expect(ttsCostUsd("x".repeat(1000))).toBeCloseTo(TTS_USD_PER_REQUEST + 1000 * TTS_USD_PER_CHAR, 9);
    expect(ttsCostUsd("x".repeat(29))).toBeCloseTo(0.000864, 9); // live SSE usage for 29 chars: $0.00082
    // PLATFORM §10.1: a voiced sim (≈ 14 clips, ≤ 1200 chars) ≈ $0.025, inside the $0.06 reserve
    expect(14 * TTS_USD_PER_REQUEST + 1200 * TTS_USD_PER_CHAR).toBeLessThan(0.03);
    expect(ttsCostUsd("")).toBeGreaterThan(0);
  });

  it("a miss reserves (openai/tts, env), speaks with the pinned model, settles from chars and caches", async () => {
    const { tts, ledger, cache, log } = service();
    const clip = await tts.synth(req("  Yes,   that's right. "));
    expect(clip.cached).toBe(false);
    expect(clip.usd).toBe(ttsCostUsd("Yes, that's right."));
    expect(log).toEqual([{ input: "Yes, that's right.", voice: "marin", instructions: "calm", model: "gpt-4o-mini-tts-2025-12-15" }]);
    expect(ledger.calls).toEqual([
      { op: "reserve", id: "led_1", provider: "openai", action: "tts", estUsd: clip.usd, env: "dev-wp17", refId: "sim_test" },
      { op: "settle", id: "led_1", usd: clip.usd },
    ]);
    expect(clip.hash).toBe(ttsHash(TTS_MODEL, "marin", "calm", normalizeTtsText("Yes, that's right.")));
    expect(clip.durationMs).toBe(Math.round((clip.pcm24k.byteLength / 2 / 24_000) * 1000));
    expect((await cache.get(clip.hash))?.pcm24k).toEqual(clip.pcm24k);
  });

  it("a hit costs $0: no upstream, no ledger", async () => {
    const { tts, ledger, log } = service();
    await tts.synth(req("Yes, go ahead."));
    const again = await tts.synth(req("Yes,  go ahead."));
    expect(again).toMatchObject({ cached: true, usd: 0 });
    expect(log).toHaveLength(1);
    expect(ledger.calls.filter((c) => c.op === "reserve")).toHaveLength(1);
  });

  it("concurrent requests for one clip share one upstream call", async () => {
    const { tts, log } = service();
    const [a, b, c] = await Promise.all([tts.synth(req("Hello.")), tts.synth(req("Hello.")), tts.synth(req("Hello."))]);
    expect(log).toHaveLength(1);
    expect(a.hash).toBe(b.hash);
    expect([a.usd, b.usd, c.usd].filter((u) => u > 0)).toHaveLength(1);
  });

  it("a refused reservation throws E_BUDGET before any request", async () => {
    const ledger = fakeLedger({ refuse: true });
    const { tts, log } = service({ ledger: () => ledger });
    await expect(tts.synth(req("Hello."))).rejects.toMatchObject({ code: "E_BUDGET" });
    expect(log).toHaveLength(0);
  });

  it("a failure before any audio releases; after audio arrived it settles", async () => {
    const l1 = fakeLedger();
    const s1 = service({ ledger: () => l1, speak: async () => { throw new Error("boom"); } });
    await expect(s1.tts.synth(req("Hello."))).rejects.toBeInstanceOf(BatonError);
    expect(l1.calls.map((c) => c.op)).toEqual(["reserve", "release"]);

    const l2 = fakeLedger();
    const s2 = service({ ledger: () => l2, speak: async () => { throw Object.assign(new Error("reset"), { receivedBytes: 4800 }); } });
    await expect(s2.tts.synth(req("Hello."))).rejects.toMatchObject({ code: "E_INTERNAL" });
    expect(l2.calls.map((c) => c.op)).toEqual(["reserve", "settle"]);
    expect(await s2.cache.get(s2.tts.hashOf(req("Hello.")))).toBeNull();
  });

  it("maps a timeout to E_OPENAI_TIMEOUT and rejects odd or empty audio", async () => {
    const timeout = Object.assign(new Error("t"), { name: "TimeoutError" });
    await expect(service({ speak: async () => { throw timeout; } }).tts.synth(req("Hi."))).rejects.toMatchObject({ code: "E_OPENAI_TIMEOUT" });
    const odd = service({ speak: async () => new Uint8Array(3) });
    await expect(odd.tts.synth(req("Hi."))).rejects.toBeInstanceOf(BatonError);
    expect(odd.ledger.calls.map((c) => c.op)).toEqual(["reserve", "settle"]);
  });

  it("validates voice and length", async () => {
    const { tts, log } = service();
    await expect(tts.synth(req("Hi.", "alloy"))).rejects.toMatchObject({ code: "E_BAD_REQUEST" });
    await expect(tts.synth(req("x".repeat(601)))).rejects.toMatchObject({ code: "E_BAD_REQUEST" });
    await expect(tts.synth(req("   "))).rejects.toMatchObject({ code: "E_BAD_REQUEST" });
    expect(log).toHaveLength(0);
  });

  it("synthMany keeps input order and bounds concurrency", async () => {
    let live = 0;
    let peak = 0;
    const { tts } = service({
      speak: async (_c, r) => {
        live++;
        peak = Math.max(peak, live);
        await new Promise((res) => setTimeout(res, 5));
        live--;
        return tone24k(100 + r.input.length);
      },
    });
    const texts = ["a1", "b22", "c333", "d4444", "e55555", "f666666"];
    const out = await tts.synthMany(texts.map((t) => req(t)), 2);
    expect(out.map((c) => c.durationMs)).toEqual(texts.map((t) => Math.round(100 + t.length)));
    expect(peak).toBeLessThanOrEqual(2);
  });

  it("a ledger outage fails closed (the TTS call never runs unrecorded)", async () => {
    const { tts, log } = service({ ledger: () => { throw new Error("no authority"); } });
    await expect(tts.synth(req("Hello."))).rejects.toThrow();
    expect(log).toHaveLength(0);
  });
});
