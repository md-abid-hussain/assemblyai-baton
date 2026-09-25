/**
 * calls:build end to end on SYNTHETIC takes (spikes/fixtures/dialog_stereo_16k.wav → 8 kHz split, fake sidecars and a
 * kit manifest) in a temp dir: never data/calls.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { mulawDecode } from "../../../../src/core/audio/mulaw";
import { CachedTurnsFileSchema } from "../../../../src/core/contracts/eval";
import { CallManifestEntrySchema, PeaksSchema, ScenarioSchema, type CallManifestEntry } from "../../../../src/core/contracts/scenario";
import { serializeSttCacheRecord } from "../../../../src/core/scenario/stt-cache";
import { buildCalls } from "../../../../scripts/calls/build-assets";
import { mainCheckoutOf, readSplit, REPO_ROOT, resolvePaths, sttCachePath, type PipelinePaths } from "../../../../scripts/calls/lib/kit-io";
import { writeSyntheticTake } from "../../../../scripts/calls/synthetic-take";
import { fakeCache, tmp, treeHash, turn } from "./helpers";

let root: string;
let paths: PipelinePaths;
const bases: Record<string, string> = {};

beforeAll(async () => {
  root = tmp("build");
  const callsDir = join(root, "calls");
  bases.s01old = writeSyntheticTake(callsDir, { scenarioId: "s01", take: 1, review: "unreviewed", maxMs: 6000 }).base;
  bases.s01 = writeSyntheticTake(callsDir, { scenarioId: "s01", take: 2, review: "keep", maxMs: 8000 }).base;
  bases.s03 = writeSyntheticTake(callsDir, { scenarioId: "s03", publishable: false, maxMs: 5000 }).base;
  bases.s02 = writeSyntheticTake(callsDir, { scenarioId: "s02", mono: true, maxMs: 5000 }).base;
  bases.s05 = writeSyntheticTake(callsDir, { scenarioId: "s05", review: "discard", maxMs: 3000 }).base;
  paths = resolvePaths({ callsDir, outRoot: join(root, "out"), dataRoot: join(root, "out") });
  // A complete pc_ctx STT cache for the featured take (produced by the real runner over fake sessions).
  const cache = await fakeCache(bases.s01, "pc_ctx", 8000, [{ atMs: 1500, msg: turn(0, "Harbor Point claims", true, 100, 1200) }], [{ atMs: 3000, msg: turn(0, "Hi it's Priya", true, 2000, 2800) }]);
  const p = sttCachePath(paths.dataRoot, bases.s01, "pc_ctx");
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, `${cache.records.map(serializeSttCacheRecord).join("\n")}\n`);
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

const readCalls = (): CallManifestEntry[] => JSON.parse(readFileSync(join(paths.outRoot, "src/generated/calls.json"), "utf8")) as CallManifestEntry[];

describe("calls:build on synthetic takes", () => {
  let first: ReturnType<typeof buildCalls>;
  let inputsBefore: Record<string, string>;
  beforeAll(() => {
    inputsBefore = treeHash(paths.callsDir);
    first = buildCalls(paths);
  });

  it("emits valid manifests; exactly one featured entry, publishable, with assets on disk", () => {
    const calls = readCalls();
    for (const c of calls) expect(CallManifestEntrySchema.safeParse(c).success, c.callId).toBe(true);
    expect(calls.map((c) => c.callId).sort()).toEqual([bases.s01old, bases.s01, bases.s02, bases.s03].sort()); // discard excluded
    const featured = calls.filter((c) => c.featured);
    expect(featured).toHaveLength(1);
    const f = featured[0]!;
    expect([f.callId, f.publishAudio, f.picker]).toEqual([bases.s01, true, "main"]);
    expect(f.assets).not.toBeNull();
    for (const url of Object.values(f.assets!)) expect(existsSync(join(paths.outRoot, "public", url))).toBe(true);
    const scenarios = JSON.parse(readFileSync(join(paths.outRoot, "src/generated/scenarios.json"), "utf8")) as unknown[];
    expect(scenarios).toHaveLength(22);
    for (const s of scenarios) expect(ScenarioSchema.safeParse(s).success).toBe(true);
    const perTake = JSON.parse(readFileSync(join(paths.outRoot, "src/generated/call-scenarios.json"), "utf8")) as Record<string, unknown>;
    expect(Object.keys(perTake).sort()).toEqual(calls.map((c) => c.callId).sort());
  });

  it("assets: content-hashed names; µ-law bytes decode back to the split audio; peaks valid", () => {
    const f = readCalls().find((c) => c.featured)!;
    expect(f.assets!.rep).toMatch(new RegExp(`^/calls/${f.callId}/rep\\.[0-9a-f]{8}\\.ulaw$`));
    expect(f.format).toEqual({ encoding: "pcm_mulaw", sampleRate: 8000 });
    const ulaw = new Uint8Array(readFileSync(join(paths.outRoot, "public", f.assets!.rep)));
    const pcm = readSplit(paths.callsDir, f.callId)!;
    expect(ulaw.byteLength).toBe(pcm.rep.length);
    expect(f.durationMs).toBe(8000);
    const decoded = mulawDecode(ulaw);
    let maxErr = 0;
    for (let i = 0; i < decoded.length; i++) maxErr = Math.max(maxErr, Math.abs(decoded[i]! - pcm.rep[i]!) / (Math.abs(pcm.rep[i]!) + 64));
    expect(maxErr).toBeLessThan(0.1); // G.711 is ~6% relative error at worst
    const peaks = PeaksSchema.parse(JSON.parse(readFileSync(join(paths.outRoot, "public", f.assets!.peaks), "utf8")));
    expect(peaks.rep).toHaveLength(400);
  });

  it("publishes audio for publishable takes only; MONO takes are hidden and out of eval", () => {
    const calls = readCalls();
    const priv = calls.find((c) => c.callId === bases.s03)!;
    expect([priv.publishAudio, priv.assets, priv.picker]).toEqual([false, null, "hidden"]);
    expect(existsSync(join(paths.outRoot, "public/calls", bases.s03!))).toBe(false);
    expect(readdirSync(join(paths.outRoot, "public/calls")).sort()).toEqual([bases.s01, bases.s01old, bases.s02].sort());
    const mono = calls.find((c) => c.callId === bases.s02)!;
    expect([mono.inEval, mono.picker, mono.featured]).toEqual([false, "hidden", false]);
    expect(first.warnings.join("\n")).toMatch(/not a 2-channel recording/);
    expect(calls.find((c) => c.callId === bases.s01old)!.picker).toBe("hidden"); // not the chosen take
  });

  it("publishes cached turns from a complete pc_ctx cache (Turn messages only, per channel)", () => {
    const p = join(paths.outRoot, "public/data/cached-turns", `${bases.s01}.json`);
    const file = CachedTurnsFileSchema.parse(JSON.parse(readFileSync(p, "utf8")));
    expect(file.variant).toBe("pc_ctx");
    expect(file.transcribedAt).toBe("2026-09-25T05:00:00.000Z");
    expect(file.channels.rep.map((r) => r.message["transcript"])).toEqual(["Harbor Point claims"]);
    expect(file.channels.customer.map((r) => r.recvMs)).toEqual([3000]);
    expect(readdirSync(join(paths.outRoot, "public/data/cached-turns"))).toEqual([`${bases.s01}.json`]);
  });

  it("only reads the kit files (inputs byte- and mtime-identical)", () => {
    expect(treeHash(paths.callsDir)).toEqual(inputsBefore);
  });

  it("is idempotent: a second build changes nothing; --check agrees", () => {
    const before = treeHash(paths.outRoot);
    const again = buildCalls(paths);
    expect(again.changed).toEqual([]);
    expect(treeHash(paths.outRoot)).toEqual(before);
    expect(buildCalls(paths, { check: true }).changed).toEqual([]);
  });

  it("prunes: a take that stops being publishable loses its public audio; stale files are removed; --check sees drift", () => {
    const stale = join(paths.outRoot, "public/calls", bases.s01!, "rep.deadbeef.ulaw");
    writeFileSync(stale, "old");
    writeFileSync(join(paths.outRoot, "public/calls/orphan.txt"), "x");
    expect(buildCalls(paths, { check: true }).changed.length).toBeGreaterThan(0);
    const scPath = join(paths.callsDir, "raw", `${bases.s01old}.json`);
    const original = readFileSync(scPath, "utf8");
    try {
      const sc = JSON.parse(original) as { consent: { publishable: boolean } };
      sc.consent.publishable = false;
      writeFileSync(scPath, JSON.stringify(sc));
      const r = buildCalls(paths);
      expect(existsSync(stale)).toBe(false);
      expect(existsSync(join(paths.outRoot, "public/calls/orphan.txt"))).toBe(false);
      expect(existsSync(join(paths.outRoot, "public/calls", bases.s01old!))).toBe(false);
      expect(r.changed.some((c) => c.includes(`${bases.s01old} (removed)`))).toBe(true);
    } finally {
      writeFileSync(scPath, original);
    }
  });

  it("refuses a missing calls dir instead of pruning everything", () => {
    expect(() => buildCalls({ ...paths, callsDir: join(root, "nope") })).toThrow(/calls dir not found/);
  });
});

describe("paths", () => {
  it("a worktree reads the main checkout's data/calls by default; flags and env override", () => {
    expect(mainCheckoutOf("C:\\x\\assembly-ai\\.wt\\wp9")).toBe("C:\\x\\assembly-ai");
    expect(mainCheckoutOf("/home/u/repo")).toBe("/home/u/repo");
    const p = resolvePaths({}, {});
    expect(p.callsDir).toBe(join(mainCheckoutOf(REPO_ROOT), "data", "calls"));
    expect(resolvePaths({}, { BATON_CALLS_DIR: root }).callsDir).toBe(root);
    expect(resolvePaths({ callsDir: join(root, "a") }, { BATON_CALLS_DIR: root }).callsDir).toBe(join(root, "a"));
  });

  it("the synthetic generator refuses the real data/calls", () => {
    expect(() => writeSyntheticTake(join(mainCheckoutOf(REPO_ROOT), "data", "calls"))).toThrow(/refusing/);
  });
});
