/**
 * The SIMULATED take fallback (WP9·2): script repair, the call-clock layout, the sidecar's provenance, the labels
 * derived from the timeline, and - the point of the whole thing - that `calls:build` features a simulated s01 while
 * no real take exists and drops it by itself the moment one does.
 *
 * $0: the OpenAI writer and TTS are both injected (`deps.write` / `deps.speak`).
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { decodeWav } from "../../../../src/core/audio/wav-decode";
import { CallProvenanceFileSchema, type CallProvenanceFile } from "../../../../src/core/contracts/ext/wp9-data";
import { CallLabelsSchema, CallManifestEntrySchema, type CallManifestEntry } from "../../../../src/core/contracts/scenario";
import { KitScenarioSchema, KitSidecarSchema, isSimulatedTake, parseKit, type KitScenario } from "../../../../src/core/scenario/kit";
import {
  enforceHandoff, planSimTimeline, simBase, simChannelsOf, simLabels, simSidecar, simStereoOf, trimClip,
  SIM_PROVENANCE_DETAIL, SIM_RATE, SIM_TTS_RATE, SIM_VOICES, type SimClip, type SimScript,
} from "../../../../src/core/scenario/sim-take";
import { buildSimTake } from "../../../../scripts/calls/sim-take";
import { buildCalls } from "../../../../scripts/calls/build-assets";
import { assertNotRecordingKitDir, isRecordingKitDir, loadKit, resolvePaths, takeDirOf, type PipelinePaths } from "../../../../scripts/calls/lib/kit-io";
import { writeSyntheticTake } from "../../../../scripts/calls/synthetic-take";
import { tmp } from "./helpers";

const SCENARIOS_DIR = join(process.cwd(), "data", "scenarios");
const s01 = (): KitScenario => parseKit(KitScenarioSchema, JSON.parse(readFileSync(join(SCENARIOS_DIR, "s01.json"), "utf8")), "s01");
const AT = "2026-09-25T11:00:00.000Z";

/** A 24 kHz clip whose length is proportional to the text, with 120 ms of digital silence at each end. */
function fakeSpeech(text: string): Int16Array {
  const bodyMs = Math.max(400, text.length * 55);
  const pad = Math.round((120 * SIM_TTS_RATE) / 1000);
  const body = Math.round((bodyMs * SIM_TTS_RATE) / 1000);
  const out = new Int16Array(pad * 2 + body);
  for (let i = 0; i < body; i++) out[pad + i] = Math.round(9000 * Math.sin((2 * Math.PI * 220 * i) / SIM_TTS_RATE));
  return out;
}

const scriptFor = (sc: KitScenario): SimScript => ({
  scenarioId: sc.id,
  turns: [
    { beat: 1, who: "rep", text: "Harborview Insurance, this is Daniel. This call is recorded for quality and training. How can I help?" },
    { beat: 2, who: "customer", text: "Hi, I'd like to add my daughter to my car insurance." },
    { beat: 6, who: "customer", text: "Maya Raman, M-A-Y-A. March 14th, 2009, so she's seventeen." },
    { beat: 15, who: "rep", text: "That comes to $142 a month, up $46 from your $96." },
    { beat: 16, who: "customer", text: "Oof. Okay, go ahead." },
    { beat: 17, who: "rep", text: "Right, so I'll get the paperwork going for you now." },
    { beat: 18, who: "customer", text: "Sure, go ahead." },
    { beat: 19, who: "rep", text: "You'll hear my assistant in a second. Thanks, Priya." },
  ],
});

describe("the data/calls guard", () => {
  it("recognises every checkout's recording dir, not just the main one", () => {
    for (const d of ["/repo/data/calls", "/repo/.wt/wp9/data/calls", "C:\\x\\data\\calls\\", "/tmp/t/data/calls"]) {
      expect(isRecordingKitDir(d), d).toBe(true);
      expect(() => assertNotRecordingKitDir(d, "x")).toThrow(/refusing to write/);
    }
    for (const d of ["/repo/data/sim-takes", "/repo/data/calls-old", "/repo/calls", "/repo/data/calls/raw"]) {
      expect(isRecordingKitDir(d), d).toBe(false);
    }
  });
});

describe("enforceHandoff", () => {
  it("forces the hand-off line to the scenario's exact wording and reports the repair", () => {
    const sc = s01();
    const r = enforceHandoff(scriptFor(sc), sc);
    expect(r.script.turns[r.handoffIndex]!.text).toBe(sc.handoff.line);
    expect(r.repairs.join(" ")).toMatch(/exact wording/);
  });

  it("puts the acceptance directly after the hand-off", () => {
    const sc = s01();
    const r = enforceHandoff(scriptFor(sc), sc);
    expect(r.acceptIndex).toBe(r.handoffIndex + 1);
    expect(r.script.turns[r.acceptIndex!]!.who).toBe("customer");
  });

  it("inserts a hand-off when the writer left it out", () => {
    const sc = s01();
    const without: SimScript = { scenarioId: sc.id, turns: scriptFor(sc).turns.filter((t) => t.beat !== 17 && t.beat !== 18) };
    const r = enforceHandoff(without, sc);
    expect(r.script.turns[r.handoffIndex]!.text).toBe(sc.handoff.line);
    expect(r.acceptIndex).toBe(r.handoffIndex + 1);
    expect(r.repairs.some((x) => /missing/.test(x))).toBe(true);
  });

  it("labels no acceptance when the scenario's customer does not accept", () => {
    const sc = { ...s01(), handoff: { ...s01().handoff, customer_response: "declines" } } as KitScenario;
    expect(enforceHandoff(scriptFor(sc), sc).acceptIndex).toBeNull();
  });
});

describe("timeline and assembly", () => {
  const turns = [
    { beat: 1, who: "rep" as const, text: "one" },
    { beat: 2, who: "customer" as const, text: "two" },
    { beat: 3, who: "rep" as const, text: "three" },
  ];

  it("places turns in order with a gap, and is deterministic", () => {
    const a = planSimTimeline(turns, [1000, 800, 1200]);
    const b = planSimTimeline(turns, [1000, 800, 1200]);
    expect(a).toEqual(b);
    expect(a.turns[0]!.startMs).toBeGreaterThan(0);
    for (let i = 1; i < a.turns.length; i++) expect(a.turns[i]!.startMs).toBeGreaterThan(a.turns[i - 1]!.endMs);
    expect(a.totalMs).toBeGreaterThan(a.turns.at(-1)!.endMs);
  });

  it("writes each party on its own channel only, at its placed offset", () => {
    const t = planSimTimeline(turns, [500, 500, 500]);
    const clips: SimClip[] = t.turns.map(() => ({ samples: new Int16Array(Math.round(0.5 * SIM_RATE)).fill(8000), rate: SIM_RATE }));
    const ch = simChannelsOf(t, clips);
    expect(ch.sampleRate).toBe(SIM_RATE);
    expect(ch.rep.length).toBe(ch.customer.length);
    const at = (x: Int16Array, ms: number) => x[Math.round((ms * SIM_RATE) / 1000)]!;
    // While the customer speaks, the rep channel is silent, and vice versa.
    expect(at(ch.customer, t.turns[1]!.startMs + 100)).not.toBe(0);
    expect(at(ch.rep, t.turns[1]!.startMs + 100)).toBe(0);
    expect(at(ch.rep, t.turns[0]!.startMs + 100)).not.toBe(0);
    expect(at(ch.customer, t.turns[0]!.startMs + 100)).toBe(0);
    // The interleaved "raw" file keeps ch1 = rep, ch2 = customer.
    const stereo = simStereoOf(ch);
    expect(stereo.length).toBe(ch.rep.length * 2);
    expect(stereo[2]).toBe(ch.rep[1]);
    expect(stereo[3]).toBe(ch.customer[1]);
  });

  it("trims the silence a TTS clip starts and ends with", () => {
    const trimmed = trimClip(fakeSpeech("hello there"), { rate: SIM_TTS_RATE });
    expect(trimmed.length).toBeLessThan(fakeSpeech("hello there").length);
    expect(Math.abs(trimmed[Math.floor(trimmed.length / 2)]!)).toBeGreaterThan(0);
  });
});

describe("sidecar and labels", () => {
  it("marks provenance simulated, stays dual-channel and parses as a kit sidecar", () => {
    const sc = s01();
    const sidecar = simSidecar({
      scenario: sc, base: simBase("s01", AT), take: 1, at: AT, durationMs: 90_000, scenarioSha256: "abc",
      fileDir: "data/sim-takes", rmsDbfs: { rep: -20, customer: -21 }, peakDbfs: { rep: -3, customer: -3 },
    });
    const parsed = parseKit(KitSidecarSchema, JSON.parse(JSON.stringify(sidecar)), "sim");
    expect(isSimulatedTake(parsed)).toBe(true);
    expect(parsed.provenance!.detail).toBe(SIM_PROVENANCE_DETAIL);
    expect(parsed.provenance!.voices).toEqual({ rep: SIM_VOICES.rep, customer: SIM_VOICES.customer });
    expect(parsed.twilio.recording_channels).toBe(2);
    expect(parsed.review.notes.join(" ")).toMatch(/SIMULATED/);
    // A real kit sidecar has no provenance at all.
    expect(isSimulatedTake({ provenance: undefined })).toBe(false);
  });

  it("derives exact hand-off labels from the timeline, and never claims to be reviewed", () => {
    const t = planSimTimeline(
      [{ beat: 17, who: "rep", text: "a" }, { beat: 18, who: "customer", text: "b" }],
      [2200, 900],
    );
    const l = simLabels("s01_sim_x", t, 0, 1);
    expect(CallLabelsSchema.safeParse(l).success).toBe(true);
    expect(l.reviewed).toBe(false);
    expect(l.mentions).toEqual([]);
    expect(l.handoff).toEqual({ lineStartMs: t.turns[0]!.startMs, lineEndMs: t.turns[0]!.endMs, acceptStartMs: t.turns[1]!.startMs, acceptEndMs: t.turns[1]!.endMs });
  });
});

describe("buildSimTake + calls:build", () => {
  let root: string;
  let outDir: string;
  let paths: PipelinePaths;
  let callId: string;

  beforeAll(async () => {
    root = tmp("sim");
    outDir = join(root, "sim-takes");
    const callsDir = join(root, "calls");
    mkdirSync(callsDir, { recursive: true });
    paths = resolvePaths({ callsDir, simTakesDir: outDir, outRoot: join(root, "out"), dataRoot: join(root, "out") });
    const r = await buildSimTake({
      scenariosDir: SCENARIOS_DIR, outDir, dataRoot: paths.dataRoot, scenarioId: "s01", at: AT,
      deps: {
        write: async (sc) => ({ script: scriptFor(sc), usd: 0 }),
        speak: async ({ text }) => fakeSpeech(text),
      },
    });
    callId = r.callId;
  });

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("writes the recording kit's own layout, at 8 kHz, 2 channels", () => {
    expect(callId).toMatch(/^s01_sim_\d{8}T\d{6}Z$/);
    const stereo = decodeWav(new Uint8Array(readFileSync(join(outDir, "raw", `${callId}.wav`))));
    expect([stereo.sampleRate, stereo.channels]).toEqual([SIM_RATE, 2]);
    for (const role of ["rep", "customer"]) {
      const w = decodeWav(new Uint8Array(readFileSync(join(outDir, "split", `${callId}_${role}.wav`))));
      expect([w.sampleRate, w.channels]).toEqual([SIM_RATE, 1]);
      expect(w.samples.length * 2).toBe(stereo.samples.length);
    }
    expect(existsSync(join(outDir, "manifest.json"))).toBe(true);
    expect(existsSync(join(outDir, "scripts", `${callId}.json`))).toBe(true);
    expect(existsSync(join(paths.dataRoot, "data", "labels", `${callId}.json`))).toBe(true);
  });

  it("never writes into data/calls", async () => {
    await expect(
      buildSimTake({ scenariosDir: SCENARIOS_DIR, outDir: join(process.cwd(), "data", "calls"), dataRoot: paths.dataRoot, scenarioId: "s01", at: AT, deps: { write: async (sc) => ({ script: scriptFor(sc), usd: 0 }), speak: async ({ text }) => fakeSpeech(text) } }),
    ).rejects.toThrow(/refusing to write a simulated take into data\/calls/);
  });

  it("features the simulated s01 with assets, hand-off, acceptStartMs and cached-turn-ready ids", () => {
    const r = buildCalls(paths);
    const calls = JSON.parse(readFileSync(join(paths.outRoot, "src/generated/calls.json"), "utf8")) as CallManifestEntry[];
    for (const c of calls) expect(CallManifestEntrySchema.safeParse(c).success, c.callId).toBe(true);
    const featured = calls.filter((c) => c.featured);
    expect(featured).toHaveLength(1);
    const f = featured[0]!;
    expect([f.callId, f.scenarioId, f.publishAudio, f.picker]).toEqual([callId, "s01", true, "main"]);
    expect(f.assets).not.toBeNull();
    for (const url of Object.values(f.assets!)) expect(existsSync(join(paths.outRoot, "public", url))).toBe(true);
    expect(f.handoff).not.toBeNull();
    expect(f.handoff!.acceptStartMs).toBeGreaterThan(f.handoff!.lineEndMs);
    expect(f.decisionPointMs).toBe(f.handoff!.lineStartMs);
    // A simulated take must never count as a recorded take in any metric.
    expect(f.inEval).toBe(false);
    expect(r.warnings.some((w) => /SIMULATED/.test(w))).toBe(true);
  });

  it("writes call-provenance.json with humanHalf simulated and the strip's detail line", () => {
    buildCalls(paths);
    const file = JSON.parse(readFileSync(join(paths.outRoot, "src/generated/call-provenance.json"), "utf8")) as CallProvenanceFile;
    expect(CallProvenanceFileSchema.safeParse(file).success).toBe(true);
    expect(file[callId]!.humanHalf).toBe("simulated");
    expect(file[callId]!.detail).toBe(SIM_PROVENANCE_DETAIL);
    expect(file[callId]!.voices).toEqual({ rep: SIM_VOICES.rep, customer: SIM_VOICES.customer });
  });

  it("is idempotent: a second build changes nothing", () => {
    buildCalls(paths);
    expect(buildCalls(paths, { check: true }).changed).toEqual([]);
  });

  it("drops the simulated take as soon as a real take of the same scenario exists", () => {
    const realBase = writeSyntheticTake(paths.callsDir, { scenarioId: "s01", take: 1, review: "keep", maxMs: 8000 }).base;
    const kit = loadKit(paths);
    expect(kit.simulatedScenarioIds).toEqual([]);
    expect(kit.sidecars.map((s) => s.base)).toEqual([realBase]);
    expect(takeDirOf(paths, kit.sidecars[0]!)).toBe(paths.callsDir);

    const r = buildCalls(paths);
    const calls = JSON.parse(readFileSync(join(paths.outRoot, "src/generated/calls.json"), "utf8")) as CallManifestEntry[];
    expect(calls.map((c) => c.callId)).toEqual([realBase]);
    expect(calls.find((c) => c.featured)!.callId).toBe(realBase);
    // The stand-in's public assets are pruned, and it is recorded again as a recording.
    expect(existsSync(join(paths.outRoot, "public", "calls", callId))).toBe(false);
    const file = JSON.parse(readFileSync(join(paths.outRoot, "src/generated/call-provenance.json"), "utf8")) as CallProvenanceFile;
    expect(Object.keys(file)).toEqual([realBase]);
    expect(file[realBase]!.humanHalf).toBe("recorded");
    expect(r.warnings.some((w) => /SIMULATED/.test(w))).toBe(false);
    // The inputs are still on disk: nothing deleted the generated take, it simply stepped aside.
    expect(existsSync(join(outDir, "raw", `${callId}.json`))).toBe(true);
  });

  it("ignores a take in the sim dir that does not label itself simulated", () => {
    const stray = join(root, "stray");
    mkdirSync(join(stray, "raw"), { recursive: true });
    const sidecar = JSON.parse(readFileSync(join(outDir, "raw", `${callId}.json`), "utf8")) as Record<string, unknown>;
    delete sidecar.provenance;
    writeFileSync(join(stray, "raw", `${callId}.json`), JSON.stringify(sidecar));
    const p = resolvePaths({ callsDir: join(root, "empty-calls"), simTakesDir: stray, outRoot: join(root, "out2"), dataRoot: join(root, "out2") });
    mkdirSync(p.callsDir, { recursive: true });
    const kit = loadKit(p);
    expect(kit.sidecars).toEqual([]);
    expect(kit.warnings.some((w) => /must label themselves/.test(w))).toBe(true);
  });
});
