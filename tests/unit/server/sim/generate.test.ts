import type OpenAI from "openai";
import { describe, expect, it } from "vitest";

import { SHARED_CUSTOMER_CLIPS, SIM_CALL_ID_RE, SimScriptStoredSchema } from "@/core/contracts/ext/wp17-sim";
import { CallManifestEntrySchema } from "@/core/contracts/scenario";
import { SimScriptSchema } from "@/core/contracts/v2/api";
import { ttsCostUsd, TtsService } from "@/server/openai/tts";
import { simCallIdFor, voiceSimCall } from "@/server/sim/generate";
import { MemorySimCallStore } from "@/server/sim/store";
import { MemoryTtsCache } from "@/server/sim/tts-cache";
import { CUSTOMER_INSTRUCTIONS, planAiClips } from "@/server/sim/voices";
import { blueprintFixture, fakeLedger, fakeSpeak, REP_LINE, scriptFixture } from "./helpers";

const relay = { relayId: "rl_dental", slug: "dental-deposit", title: "Dental deposit", blueprintHash: null };

function setup(cache = new MemoryTtsCache()) {
  const ledger = fakeLedger();
  const log: { input: string; voice: string; instructions: string; model: string }[] = [];
  const tts = new TtsService({ openai: () => ({}) as OpenAI, cache, ledger: () => ledger, env: () => "dev-wp17", speak: fakeSpeak({ log }) });
  return { tts, ledger, log, cache };
}

const input = (id: string) => ({
  simCallId: id, script: scriptFixture(), blueprint: blueprintFixture, sampleIndex: 0, relay, relayVersionId: "rv_test", gallery: false, scriptUsd: 0.003,
});

describe("simCallIdFor", () => {
  it("is sim_<16 hex>, deterministic, and salted", () => {
    const a = simCallIdFor({ kind: "audio", versionKey: "rv_1", sampleIndex: 0, salt: "gallery" });
    expect(a).toMatch(SIM_CALL_ID_RE);
    expect(simCallIdFor({ kind: "audio", versionKey: "rv_1", sampleIndex: 0, salt: "gallery" })).toBe(a);
    expect(simCallIdFor({ kind: "audio", versionKey: "rv_1", sampleIndex: 0, salt: "n2" })).not.toBe(a);
    expect(simCallIdFor({ kind: "text_dry_run", versionKey: "rv_1", sampleIndex: 0, salt: "gallery" })).not.toBe(a);
  });
});

describe("voiceSimCall (script → TTS → assembled row)", () => {
  it("voices both sides with the right voices, the exact handoff line, and the AI-half clips", async () => {
    const { tts, log, ledger } = setup();
    const id = simCallIdFor({ kind: "audio", versionKey: "rv_test", sampleIndex: 0, salt: "t" });
    const v = await voiceSimCall(tts, input(id));
    const turns = v.row.script.turns;
    expect(turns).toHaveLength(10);
    expect(turns[8]!.text).toBe(REP_LINE);
    expect(SimScriptSchema.parse(v.row.script).turns).toHaveLength(10);
    expect(SimScriptStoredSchema.parse(v.row.script).timeline).toHaveLength(10);

    const rep = log.filter((l) => l.voice === "cedar");
    const cus = log.filter((l) => l.voice === "marin");
    expect(rep.map((l) => l.input)).toContain(REP_LINE);
    expect(rep.every((l) => l.instructions.includes("Dana") && l.instructions.includes("BrightSmile Dental") && l.instructions.includes("Warm, upbeat"))).toBe(true);
    expect(cus.every((l) => l.instructions === CUSTOMER_INSTRUCTIONS)).toBe(true);

    expect(Object.keys(v.row.aiClips).sort()).toEqual(["answer:insurance_carrier", "close", "confirm", "consent"]);
    expect(v.row.aiClips.confirm!.text).toBe(SHARED_CUSTOMER_CLIPS.confirm);
    expect(v.row.aiClips["answer:insurance_carrier"]!.text).toBe("It's BrightSmile Plus.");
    // "Yes, that's right." is also a human-half line: one clip, one charge.
    expect(v.row.aiClips.confirm!.hash).toBe(v.row.script.timeline[7]!.clipHash);

    const distinct = [...new Set(log.map((l) => `${l.voice}|${l.input}`))];
    expect(log).toHaveLength(distinct.length);
    const charged = distinct.reduce((s, k) => s + ttsCostUsd(k.slice(6)), 0);
    expect(v.ttsUsd).toBeCloseTo(charged, 6);
    expect(v.row.usd).toBeCloseTo(charged + 0.003, 6);
    expect(ledger.calls.filter((c) => c.op === "reserve")).toHaveLength(distinct.length);
    expect(ledger.calls.filter((c) => c.op === "settle")).toHaveLength(distinct.length);
    expect(v.humanChars).toBeLessThanOrEqual(1200);
    expect(v.row.durationMs).toBeLessThanOrEqual(90_000);
    expect(v.row.handoff.lineStartMs).toBe(v.row.script.timeline[8]!.startMs);
  });

  it("re-running on a warm cache is $0 and byte-identical (build-gallery acceptance 1)", async () => {
    const cache = new MemoryTtsCache();
    const first = await voiceSimCall(setup(cache).tts, input("sim_00000000000000aa"));
    const warm = setup(cache);
    const again = await voiceSimCall(warm.tts, input("sim_00000000000000aa"));
    expect(warm.log).toHaveLength(0);
    expect(warm.ledger.calls).toHaveLength(0);
    expect(again.ttsUsd).toBe(0);
    expect(again.cachedClips).toBe(again.totalClips);
    expect(Buffer.from(again.row.rep!).equals(Buffer.from(first.row.rep!))).toBe(true);
    expect(Buffer.from(again.row.customer!).equals(Buffer.from(first.row.customer!))).toBe(true);
    expect(JSON.stringify({ ...again.row, rep: null, customer: null, usd: 0 })).toBe(JSON.stringify({ ...first.row, rep: null, customer: null, usd: 0 }));
  });

  it("shared customer clips hash the same across relays (generated once, globally)", async () => {
    const cache = new MemoryTtsCache();
    const a = await voiceSimCall(setup(cache).tts, input("sim_00000000000000a1"));
    const other = { ...blueprintFixture, playbook: { persona: { tone: "Crisp and formal." } } } as typeof blueprintFixture;
    const s = setup(cache);
    const b = await voiceSimCall(s.tts, { ...input("sim_00000000000000b2"), blueprint: other });
    expect(b.row.aiClips.confirm!.hash).toBe(a.row.aiClips.confirm!.hash);
    expect(b.row.aiClips.consent!.hash).toBe(a.row.aiClips.consent!.hash);
    expect(s.log.every((l) => l.voice === "cedar")).toBe(true); // only the rep lines (new tone) were voiced again
  });

  it("registers in the store and resolves as a synthesized CallManifestEntry", async () => {
    const cache = new MemoryTtsCache();
    const store = new MemorySimCallStore({ tts: cache });
    const id = "sim_00000000000000c3";
    const v = await voiceSimCall(setup(cache).tts, input(id));
    expect(await store.insert(v.row)).toEqual({ id, created: true });
    expect(await store.insert(v.row)).toEqual({ id, created: false });
    const r = (await store.resolveCall(id))!;
    expect(CallManifestEntrySchema.parse(r.entry)).toEqual({
      callId: id, scenarioId: "relay:dental-deposit", title: "Dental deposit · simulated call", source: "twilio8k", language: "en",
      durationMs: v.row.durationMs, format: { encoding: "pcm_mulaw", sampleRate: 8000 }, publishAudio: true, inEval: false, featured: false,
      picker: "hidden", decisionPointMs: v.row.handoff.lineStartMs, handoff: v.row.handoff, recordedAiBundle: null, customerTailPack: null,
      assets: { rep: `/api/sim-calls/${id}/rep.ulaw`, customer: `/api/sim-calls/${id}/customer.ulaw`, peaks: `/api/sim-calls/${id}/peaks.json` },
    });
    expect(r).toMatchObject({ simulated: true, relayVersionId: "rv_test", sampleIndex: 0, gallery: false, relay });
    expect(r.aiClips.close!.url).toBe(`/api/sim-calls/${id}/clip.${v.row.aiClips.close!.hash}.pcm`);
    expect(r.timeline).toHaveLength(10);
  });

  it("plans the AI clips from the script (fallbacks for blank phrases, one per field)", () => {
    const p = planAiClips({ consent_phrase: " ", closing_phrase: "Bye now.", ai_half_answers: [{ field: "a_b", spoken: "X." }, { field: "a_b", spoken: "Y." }] });
    expect(p).toEqual([
      { key: "confirm", text: SHARED_CUSTOMER_CLIPS.confirm },
      { key: "consent", text: SHARED_CUSTOMER_CLIPS.consentGoAhead },
      { key: "close", text: "Bye now." },
      { key: "answer:a_b", text: "X." },
    ]);
  });
});
