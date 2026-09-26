/**
 * WP11·1 acceptance ($0, no network, no real timers):
 *   1. a mic-blocked s01 run runs on autopilot with ZERO live TTS calls (every byte comes from the committed pack);
 *   2. a Dental sim's AI half - and a "Try an edit" preset's - runs on autopilot off `aiClips`;
 *   3. autopilot never talks over the agent, answers each reply once, says one line during pay, and stops the
 *      moment the judge uses a chip, the text box or the mic; a recorded AI half drives nothing.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { AUTOPILOT_ARM_MS, AUTOPILOT_STALL_MS } from "@/client/customer/autopilot";
import { createCustomerInput, LOCAL_CLIP_VOLUME, type CustomerInputDeps, type CustomerInputExt } from "@/client/customer/customer-input";
import { chipClipUrl, type ChipManifest } from "@/client/customer/manifest";
import { S01_AI, S01_CALL_ID } from "@/client/fixtures/s01-script";
import type { MicSource } from "@/core/contracts/services";
import { BlueprintSchema } from "@/core/contracts/v2/blueprint";
import { compileRelay } from "@/core/relay/compile";
import { repoRoot } from "../../../../scripts/lib/load-env";

import { bytesOf, clipFetch, pcmOf, simClips, testClock, testEngine, testStore, testVa, type TestClock } from "./helpers";

const h = (c: string) => c.repeat(64);
const ASK_ZIP = "What's the ZIP code where the car is kept overnight?";
const ZIP_ANSWER = "It's 4 4 1 0 7.";
const CONFIRM = "Yes, that's right.";
const REPEAT = "Sorry, could you repeat that?";
const PAYING = "Okay, I'm paying now.";

const S01_TRUTH = { driver_full_name: "maya raman", driver_dob: "2009-03-14", garaging_zip: "44107", effective_date: "2026-10-02" };

/** The committed pack for the s01 take, with one distinguishable clip per phrase. */
function s01Pack(): { manifest: ChipManifest; files: Record<string, Uint8Array>; value: (text: string) => number } {
  const texts = [ZIP_ANSWER, CONFIRM, REPEAT, PAYING, "Yes, text me the link. No paper copy, thanks.", "No, that's everything. Thanks, bye!"];
  const hashes = texts.map((_, i) => h("0123456789abcdef"[i]!));
  const files: Record<string, Uint8Array> = {};
  texts.forEach((_, i) => {
    files[chipClipUrl(hashes[i]!)] = bytesOf(pcmOf(100 + i));
  });
  return {
    manifest: {
      version: 1, generatedAt: "2026-09-26T00:00:00.000Z", model: "test-tts", voice: "marin",
      clips: texts.map((text, i) => ({ hash: hashes[i]!, text, durationMs: 1200, voice: "synthetic" as const })),
      calls: { [S01_CALL_ID]: { scenarioId: "s01", truth: S01_TRUTH, clips: hashes } },
    },
    files,
    value: (text) => 100 + texts.indexOf(text),
  };
}

interface World {
  ci: CustomerInputExt;
  store: ReturnType<typeof testStore>;
  va: ReturnType<typeof testVa>;
  engine: ReturnType<typeof testEngine>;
  clock: TestClock;
  urls: string[];
  mics: (MicSource | null)[];
}

function world(o: Partial<CustomerInputDeps> & { files?: Record<string, Uint8Array | string>; micError?: Error } = {}): World {
  const clock = testClock();
  const store = o.store ? (o.store as ReturnType<typeof testStore>) : testStore();
  const va = testVa();
  const engine = testEngine(o.micError ? { micError: o.micError } : {});
  const { fetch, urls } = clipFetch(o.files ?? {});
  const mics: (MicSource | null)[] = [];
  const ci = createCustomerInput({
    store,
    va: () => va,
    engine: () => engine,
    setMicSource: (src) => mics.push(src),
    offerTry: false,
    fetchImpl: fetch,
    now: () => clock.now(),
    setTimeout: (cb, ms) => clock.setTimeout(cb, ms),
    clearTimeout: (id) => clock.clearTimeout(id),
    ...o,
  } as CustomerInputDeps);
  return { ci, store, va, engine, clock, urls, mics };
}

describe("acceptance 1: a mic-blocked s01 run completes on autopilot with zero live TTS calls", () => {
  it("answers each agent request 600 ms later, from the committed pack", async () => {
    const pack = s01Pack();
    const w = world({ manifest: pack.manifest, files: pack.files, micError: new Error("NotAllowedError") });

    // The mic is blocked: the toggle reports it, and autopilot keeps working (DESIGN §7.4 E_MIC_DENIED).
    expect(await w.ci.enableMic()).toBe(false);
    w.ci.setAutopilot(true);

    w.store.agentSaid(ASK_ZIP);
    await w.clock.advance(AUTOPILOT_ARM_MS - 100);
    expect(w.va.fed).toHaveLength(0); // not yet: the 600 ms have not passed
    await w.clock.advance(200);
    expect(w.va.fed).toHaveLength(1);
    expect(w.va.fed[0]![0]).toBe(pack.value(ZIP_ANSWER));

    // …and it answers the next question too, once.
    w.store.agentSaid(S01_AI.esignText);
    await w.clock.advance(2000);
    expect(w.va.fed).toHaveLength(2);
    expect(w.va.fed[1]![0]).toBe(pack.value("Yes, text me the link. No paper copy, thanks."));

    // Zero live TTS: every byte came from /tts/, nothing from a synthesis route.
    expect(w.urls.every((u) => u.startsWith("/tts/"))).toBe(true);
    expect(w.urls.some((u) => u.includes("/api/tts"))).toBe(false);
    w.ci.dispose();
  });

  it("plays the clip locally at 70% so the judge hears their own line", async () => {
    const pack = s01Pack();
    const w = world({ manifest: pack.manifest, files: pack.files });
    w.store.agentSaid(ASK_ZIP);
    await w.clock.advance(1000);
    expect(w.engine.local).toHaveLength(1);
    expect(w.engine.local[0]?.volume).toBe(LOCAL_CLIP_VOLUME);
    expect(w.engine.local[0]?.pcm).toBe(w.va.fed[0]);
    w.ci.dispose();
  });

  it("fetches the pack over HTTP when it was not injected", async () => {
    const pack = s01Pack();
    const w = world({ files: { ...pack.files, "/tts/manifest.json": JSON.stringify(pack.manifest) } });
    await w.clock.advance(0);
    w.store.agentSaid(ASK_ZIP);
    await w.clock.advance(1000);
    expect(w.va.fed).toHaveLength(1);
    expect(w.urls[0]).toBe("/tts/manifest.json");
    w.ci.dispose();
  });
});

describe("acceptance 2: a Dental sim's AI half completes on autopilot", () => {
  const bp = BlueprintSchema.parse(JSON.parse(readFileSync(join(repoRoot(), "data/relays/dental-deposit.json"), "utf8")));
  const kernel = compileRelay(bp);
  const account = bp.context.samples[0]!;

  function simWorld(extra: Record<string, string> = {}) {
    const clips = simClips("/calls/sim-dental-deposit", {
      confirm: CONFIRM,
      consent: "Yes, please text me the link.",
      close: "No, that's everything, thanks.",
      "answer:appointment_time": "It's 9:30 AM.",
      ...extra,
    });
    const files: Record<string, Uint8Array> = {};
    Object.values(clips).forEach((c, i) => {
      files[c.url] = bytesOf(pcmOf(200 + i));
    });
    const store = testStore({ context: { ...testStore().getState().context!, callId: "sim_10280948ea62dbbb", policy: account as never } });
    return { ...world({ store, files, aiClips: clips, spec: () => kernel.spec }), clips };
  }

  it("answers an open ask with the pre-voiced clip for that field", async () => {
    const w = simWorld();
    w.store.agentSaid("What time is the appointment?");
    await w.clock.advance(1000);
    expect(w.va.fed).toHaveLength(1);
    expect(w.urls).toContain("/calls/sim-dental-deposit/clip.answer-appointment-time.pcm");
    w.ci.dispose();
  });

  it("answers a 'Try an edit' preset's extra field with the preset's own clip (no new TTS)", async () => {
    const w = simWorld({ "answer:procedure": "A cleaning, please." });
    w.store.agentSaid("And which procedure is it for?");
    await w.clock.advance(1000);
    expect(w.urls).toContain("/calls/sim-dental-deposit/clip.answer-procedure.pcm");
    w.ci.dispose();
  });

  it("closes the call when the agent asks whether there is anything else", async () => {
    const w = simWorld();
    w.store.agentSaid("Is there anything else I can help with?");
    await w.clock.advance(1000);
    expect(w.urls).toContain("/calls/sim-dental-deposit/clip.close.pcm");
    w.ci.dispose();
  });
});

describe("autopilot behaviour (DESIGN §5.15)", () => {
  it("never talks over the agent", async () => {
    const pack = s01Pack();
    const w = world({ manifest: pack.manifest, files: pack.files });
    w.store.agentSaid(ASK_ZIP);
    w.store.patch({ va: { ...w.store.getState().va, speaking: true } });
    await w.clock.advance(5000);
    expect(w.va.fed).toHaveLength(0);
    w.store.patch({ va: { ...w.store.getState().va, speaking: false } });
    await w.clock.advance(AUTOPILOT_ARM_MS + 50);
    expect(w.va.fed).toHaveLength(1);
    w.ci.dispose();
  });

  it("falls back to the 4 s stall timer after a reply that asks nothing", async () => {
    const pack = s01Pack();
    const w = world({ manifest: pack.manifest, files: pack.files });
    w.store.agentSaid("I've just texted you the link.");
    await w.clock.advance(AUTOPILOT_STALL_MS - 200);
    expect(w.va.fed).toHaveLength(0);
    await w.clock.advance(400);
    expect(w.va.fed).toHaveLength(1);
    // "Okay."/"Sure." are not voiced, so the stall picks the repeat clip instead.
    expect(w.va.fed[0]![0]).toBe(pack.value(REPEAT));
    w.ci.dispose();
  });

  it("says one line during pay and never touches the card", async () => {
    const pack = s01Pack();
    const w = world({ manifest: pack.manifest, files: pack.files });
    w.store.patch({ stage: "pay", payment: { status: "open", source: null, t: 0 } });
    w.store.agentSaid("I've texted the link. Take your time.");
    await w.clock.advance(3000);
    expect(w.va.fed).toHaveLength(1);
    expect(w.va.fed[0]![0]).toBe(pack.value(PAYING));
    w.store.agentSaid("Still waiting on the payment.");
    await w.clock.advance(10_000);
    expect(w.va.fed).toHaveLength(1); // once, not on every agent line
    w.ci.dispose();
  });

  it("stops the moment the judge uses a chip", async () => {
    const pack = s01Pack();
    const w = world({ manifest: pack.manifest, files: pack.files });
    w.store.agentSaid(ASK_ZIP);
    const chip = w.ci.suggestions()[0]!;
    await w.ci.play(chip);
    expect(w.ci.mode).toBe("chips");
    expect(w.va.fed).toHaveLength(1);
    w.store.agentSaid("And when should the change start?");
    await w.clock.advance(10_000);
    expect(w.va.fed).toHaveLength(1); // autopilot is off for the rest of the run
    w.ci.dispose();
  });

  it("does not drive a recorded AI half", async () => {
    const pack = s01Pack();
    const w = world({ manifest: pack.manifest, files: pack.files, store: testStore({ mode: "recorded_ai" }) });
    w.store.agentSaid(ASK_ZIP);
    await w.clock.advance(10_000);
    expect(w.va.fed).toHaveLength(0);
    w.ci.dispose();
  });

  it("stays quiet before the AI half and after the call ends", async () => {
    const pack = s01Pack();
    const w = world({ manifest: pack.manifest, files: pack.files, store: testStore({ phase: "shadowing" }) });
    w.store.agentSaid(ASK_ZIP);
    await w.clock.advance(10_000);
    expect(w.va.fed).toHaveLength(0);
    w.store.patch({ phase: "ai-listening", callEnded: true });
    await w.clock.advance(10_000);
    expect(w.va.fed).toHaveLength(0);
    w.ci.dispose();
  });
});

describe("the suggestion list the console renders", () => {
  it("is the contract shape only, so a recorded bundle stays clean", async () => {
    const pack = s01Pack();
    const w = world({ manifest: pack.manifest, files: pack.files });
    w.store.agentSaid(ASK_ZIP);
    const items = w.ci.suggestions();
    expect(items[0]).toEqual({ id: expect.any(String), text: ZIP_ANSWER, audioUrl: expect.stringMatching(/^\/tts\//), voice: "synthetic", kind: "answer" });
    expect(Object.keys(items[0]!).sort()).toEqual(["audioUrl", "id", "kind", "text", "voice"]);
    // A chip that came back from the UI (no internal fields) still plays, off its audioUrl.
    await w.ci.play({ ...items[0]! });
    expect(w.va.fed).toHaveLength(1);
    w.ci.dispose();
  });

  it("a typed reply is only spoken when the pack happens to carry it (typed TTS is cut)", async () => {
    const pack = s01Pack();
    const notes: string[] = [];
    const w = world({ manifest: pack.manifest, files: pack.files, log: (_l, m) => notes.push(m) });
    await w.ci.sendTyped("something nobody ever generated");
    expect(w.va.fed).toHaveLength(0);
    expect(notes.join(" ")).toContain("typed reply has no clip");
    await w.ci.sendTyped("yes, THAT'S right");
    expect(w.va.fed).toHaveLength(1);
    expect(w.ci.mode).toBe("typed");
    w.ci.dispose();
  });
});

describe("the mic toggle (optional on Baton, the sim's 'Answer the AI yourself')", () => {
  it("routes the judge's mic to the session and takes it away again", async () => {
    const pack = s01Pack();
    const w = world({ manifest: pack.manifest, files: pack.files });
    expect(await w.ci.enableMic()).toBe(true);
    expect(w.ci.mode).toBe("mic");
    expect(w.mics).toEqual([w.engine.lastMic]);
    expect(w.engine.sessions).toContain("play-and-record");

    // Autopilot is off while the judge answers.
    w.store.agentSaid(ASK_ZIP);
    await w.clock.advance(10_000);
    expect(w.va.fed).toHaveLength(0);

    await w.ci.disableMic();
    expect(w.mics.at(-1)).toBeNull();
    expect(w.ci.mode).toBe("chips");
    expect(w.engine.sessions.at(-1)).toBe("playback");
    w.ci.dispose();
  });

  it("a blocked mic leaves the chips and autopilot alone", async () => {
    const pack = s01Pack();
    const w = world({ manifest: pack.manifest, files: pack.files, micError: new Error("NotAllowedError") });
    expect(await w.ci.enableMic()).toBe(false);
    expect(w.ci.mode).toBe("chips");
    expect(w.mics).toHaveLength(0);
    w.ci.setAutopilot(true);
    w.store.agentSaid(ASK_ZIP);
    await w.clock.advance(1000);
    expect(w.va.fed).toHaveLength(1);
    w.ci.dispose();
  });

  it("only opens the microphone once", async () => {
    const pack = s01Pack();
    const w = world({ manifest: pack.manifest, files: pack.files });
    await w.ci.enableMic();
    await w.ci.enableMic();
    expect(w.engine.micOpens).toBe(1);
    w.ci.dispose();
  });
});

describe("robustness", () => {
  it("a clip that 404s is reported, not faked", async () => {
    const pack = s01Pack();
    const notes: string[] = [];
    const w = world({ manifest: pack.manifest, files: {}, log: (_l, m) => notes.push(m) });
    w.store.agentSaid(ASK_ZIP);
    await w.clock.advance(1000);
    expect(w.va.fed).toHaveLength(0);
    expect(notes.join(" ")).toContain("customer clip unavailable");
    w.ci.dispose();
  });

  it("no Voice Agent session yet: nothing is spoken and nothing throws", async () => {
    const pack = s01Pack();
    const notes: string[] = [];
    const w = world({ manifest: pack.manifest, files: pack.files, va: () => null, log: (_l, m) => notes.push(m) });
    w.store.agentSaid(ASK_ZIP);
    await w.clock.advance(1000);
    expect(notes.join(" ")).toContain("no Voice Agent session");
    w.ci.dispose();
  });

  it("dispose stops the timers and the mic", async () => {
    const pack = s01Pack();
    const w = world({ manifest: pack.manifest, files: pack.files });
    await w.ci.enableMic();
    w.ci.setAutopilot(true);
    w.store.agentSaid(ASK_ZIP);
    w.ci.dispose();
    await w.clock.advance(10_000);
    expect(w.va.fed).toHaveLength(0);
    expect(w.mics.at(-1)).toBeNull();
  });
});
