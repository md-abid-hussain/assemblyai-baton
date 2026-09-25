/**
 * WP14b·2 engine pieces without a database: the `RelayEngineFactory` LRU, the `CallCatalog` order and gallery-sim
 * mapping, the compiled view, the run helpers and the kernel binding slot. Fake kernel (WP14a·2 is not on main); $0.
 */
import { afterEach, describe, expect, it } from "vitest";

import type { CallManifestEntry } from "@/core/contracts/scenario";
import type { SimCallResolutionLite } from "@/core/contracts/ext/wp14b-engine";
import { CompiledRelayViewSchema, CreateCaseResponseV2Schema, ProvenanceStripSchema, UiSpecSchema, type Blueprint } from "@/core/contracts/v2";
import { RelayCallCatalog } from "@/server/engine/catalog";
import { compiledRelayView, strictSchemaErrors } from "@/server/engine/compile-view";
import { CachedRelayEngineFactory } from "@/server/engine/factory";
import { getKernelBinding, setKernelBinding } from "@/server/engine/kernel-binding";
import { manifestEntryOf, relayRunFields, runAccount, runProvenance } from "@/server/engine/run";
import type { RunVersion } from "@/server/relays/registry";
import { dentalBlueprint, flagshipStub } from "../relays/helpers";
import { fakeKernel } from "./helpers";

function runVersion(versionId: string, bp: Blueprint, over: Partial<RunVersion> = {}): RunVersion {
  return {
    versionId, relayId: `rly_${versionId}`, relaySlug: bp.meta.slug, version: 1, hash: `h_${versionId}`, blueprint: bp,
    flagship: false, gallery: false, origin: "user", preset: null, ...over,
  };
}

function versions(map: Record<string, RunVersion>) {
  const calls: string[] = [];
  return {
    calls,
    async runVersion(id: string) {
      calls.push(id);
      return map[id] ?? null;
    },
    async galleryVersionFor(slug: string, hash: string | null) {
      const hit = Object.values(map).find((v) => v.relaySlug === slug && v.gallery && (hash === null || v.hash === hash));
      return hit?.versionId ?? Object.values(map).find((v) => v.relaySlug === slug && v.gallery)?.versionId ?? null;
    },
  };
}

const entry = (callId: string): CallManifestEntry =>
  ({ callId, scenarioId: "s01", title: callId, source: "twilio8k", assets: { rep: `/calls/${callId}/rep.ulaw`, customer: "", peaks: "" } }) as unknown as CallManifestEntry;

afterEach(() => setKernelBinding(undefined));

describe("CachedRelayEngineFactory (LRU, TASKS-v2 §5)", () => {
  it("compiles a version once, shares concurrent misses, evicts the least recently used, and 404s unknown versions", async () => {
    const k = fakeKernel();
    const v = versions({ rv_a: runVersion("rv_a", dentalBlueprint()), rv_b: runVersion("rv_b", dentalBlueprint()), rv_c: runVersion("rv_c", dentalBlueprint(), { flagship: true }) });
    const f = new CachedRelayEngineFactory({ versions: v, compiler: () => k.compile, legacyBlueprint: async () => null, capacity: 2 });
    const [a1, a2] = await Promise.all([f.forVersion("rv_a"), f.forVersion("rv_a")]);
    expect(a1).toBe(a2);
    expect(k.compiles).toHaveLength(1);
    expect(k.compiles[0]).toEqual({ versionId: "rv_a", relayId: "rly_rv_a", hash: "h_rv_a", flagship: false });
    await f.forVersion("rv_b");
    await f.forVersion("rv_a"); // hit → rv_a most recent
    const c = await f.forVersion("rv_c"); // evicts rv_b
    expect(c.ui.relay.flagship).toBe(true);
    expect(f.cachedKeys()).toEqual(["rv_a", "rv_c"]);
    await f.forVersion("rv_b");
    expect(k.compiles.map((o) => o.versionId)).toEqual(["rv_a", "rv_b", "rv_c", "rv_b"]);
    await expect(f.forVersion("rv_none")).rejects.toMatchObject({ code: "E_NOT_FOUND" });
    expect(f.cachedKeys()).not.toContain("rv_none");
  });

  it("without a kernel every compile is a 503 that is not cached; binding later works without a rebuild", async () => {
    let compiler: ReturnType<typeof fakeKernel>["compile"] | null = null;
    const v = versions({ rv_a: runVersion("rv_a", dentalBlueprint()) });
    const f = new CachedRelayEngineFactory({ versions: v, compiler: () => compiler, legacyBlueprint: async () => null });
    expect(f.available).toBe(false);
    await expect(f.forVersion("rv_a")).rejects.toMatchObject({ code: "E_MAINTENANCE" });
    expect(f.cachedKeys()).toEqual([]);
    compiler = fakeKernel().compile;
    expect((await f.forVersion("rv_a")).versionId).toBe("rv_a");
  });

  it("a compile that throws is not cached (the next call retries)", async () => {
    let n = 0;
    const k = fakeKernel();
    const f = new CachedRelayEngineFactory({
      versions: versions({ rv_a: runVersion("rv_a", dentalBlueprint()) }),
      compiler: () => (bp, o) => {
        if (n++ === 0) throw new Error("boom");
        return k.compile(bp, o);
      },
      legacyBlueprint: async () => null,
    });
    await expect(f.forVersion("rv_a")).rejects.toThrow("boom");
    expect((await f.forVersion("rv_a")).hash).toBe("h_rv_a");
  });

  it("forVersion(null) is the flagship file, compiled as flagship with no version id; missing file → 503", async () => {
    const k = fakeKernel();
    let file: { blueprint: Blueprint; hash: string } | null = null;
    const f = new CachedRelayEngineFactory({ versions: versions({}), compiler: () => k.compile, legacyBlueprint: async () => file });
    await expect(f.forVersion(null)).rejects.toMatchObject({ code: "E_MAINTENANCE" });
    file = { blueprint: flagshipStub(), hash: "hflag" };
    const c = await f.forVersion(null);
    expect(k.compiles.at(-1)).toEqual({ versionId: null, relayId: null, hash: "hflag", flagship: true });
    expect(c.ui.relay).toMatchObject({ slug: "baton-add-driver", flagship: true, versionId: null });
    expect(f.cachedKeys()).toEqual(["legacy"]);
  });
});

describe("RelayCallCatalog (PLATFORM §7.5 step 4)", () => {
  const galleryV = runVersion("rv_gal", dentalBlueprint(), { gallery: true, hash: "hash_dental" });
  const userV = runVersion("rv_user", dentalBlueprint());
  const sim = (over: Partial<SimCallResolutionLite>): SimCallResolutionLite => ({
    entry: entry("sim_abc"), simulated: true, relayVersionId: null, relay: { slug: "dental-deposit", title: "Dental deposit", blueprintHash: "hash_dental" },
    sampleIndex: 0, gallery: true, ...over,
  });

  it("recorded calls first (simulated false, no version, no account); then sims; null when neither knows the id", async () => {
    let resolverCalls = 0;
    const cat = new RelayCallCatalog({
      calls: { getCall: async (id) => (id === "s01_take1" ? entry(id) : null) },
      sims: () => ({ resolveCall: async (id) => (resolverCalls++, id === "sim_abc" ? sim({}) : null) }),
      versions: versions({ rv_gal: galleryV, rv_user: userV }),
    });
    const rec = await cat.resolve("s01_take1");
    expect(rec).toMatchObject({ callId: "s01_take1", simulated: false, relayVersionId: null, account: null, simCallId: null, gallerySim: false });
    expect(resolverCalls).toBe(0);
    const s = await cat.resolve("sim_abc");
    expect(s).toMatchObject({ callId: "sim_abc", simulated: true, relayVersionId: "rv_gal", simCallId: "sim_abc", sampleIndex: 0, gallerySim: true });
    expect(s!.account).toEqual(galleryV.blueprint.context.samples[0]);
    expect(manifestEntryOf(s!)).toEqual(entry("sim_abc"));
    expect(await cat.resolve("nope")).toBeNull();
  });

  it("a DB sim keeps its own version; a gallery sim whose hash is gone maps to the relay's current version; no resolver → recorded only", async () => {
    const v = versions({ rv_gal: galleryV, rv_user: userV });
    const cat = new RelayCallCatalog({
      calls: { getCall: async () => null },
      sims: () => ({ resolveCall: async (id) => (id === "db" ? sim({ relayVersionId: "rv_user", gallery: false }) : sim({ relay: { slug: "dental-deposit", title: "x", blueprintHash: "stale" } })) }),
      versions: v,
    });
    expect(await cat.resolve("db")).toMatchObject({ relayVersionId: "rv_user", gallerySim: false });
    expect(await cat.resolve("gal")).toMatchObject({ relayVersionId: "rv_gal" });
    const none = new RelayCallCatalog({ calls: { getCall: async () => null }, sims: () => null, versions: v });
    expect(await none.resolve("gal")).toBeNull();
  });
});

describe("compiled view (PLATFORM §7.3)", () => {
  it("greetings for every sample × canned state, prompts/tools per stage, extractor strictness, first update", () => {
    const k = fakeKernel();
    const bp = dentalBlueprint();
    const compiled = k.compile(bp, { versionId: "rv_a", relayId: "rly_a", hash: "habc", flagship: false });
    const view = CompiledRelayViewSchema.parse(compiledRelayView({ relayId: "rly_a", versionId: "rv_a", blueprint: bp, lint: [], compiled, binding: k, deployId: "dev-test" }));
    expect(view.hash).toBe("habc");
    expect(view.kernelVersion).toBe("kernel-test");
    expect(view.greetings).toHaveLength(bp.context.samples.length * 4);
    expect(view.greetings[0]).toMatchObject({ state: "all_verified", sampleIndex: 0 });
    expect(view.greetings.every((g) => g.estSeconds === Math.round(g.wordCount * 0.34 * 10) / 10)).toBe(true);
    expect(view.prompts.map((p) => p.stage)).toEqual(compiled.ui.stages.map((s) => s.kind));
    expect(view.prompts[0]!.text).toContain("[dev-test]");
    expect(view.prompts[0]!.chars).toBe(view.prompts[0]!.text.length);
    expect(view.extractor).toMatchObject({ versionId: "x-habc", formatName: "dental_deposit_patch", strictOk: true });
    expect(view.firstUpdate).toEqual({ ok: true, reason: null });
    k.failFirstUpdate = true;
    const bad = compiledRelayView({ relayId: "rly_a", versionId: "rv_a", blueprint: bp, lint: [], compiled, binding: k, deployId: "dev-test" });
    expect(bad.firstUpdate).toEqual({ ok: false, reason: "E_VA_CONFIG: tool name not allowed" });
  });

  it("strictSchemaErrors: open objects and optional properties are reported, nested included", () => {
    expect(strictSchemaErrors({ type: "object", additionalProperties: false, required: ["a"], properties: { a: { type: "string" } } })).toEqual([]);
    expect(strictSchemaErrors({
      type: "object", required: ["a"], properties: {
        a: { type: "array", items: { type: "object", additionalProperties: false, required: [], properties: { x: { type: "string" } } } },
        b: { anyOf: [{ type: "string" }, { type: "null" }] },
      },
    })).toEqual(["$: additionalProperties must be false", "$.b: not in required", "$.a.items.x: not in required"]);
  });
});

describe("run helpers", () => {
  it("the account is the RUN version's sample at the sim's index (a preset's numbers), else sample 0", () => {
    const bp = dentalBlueprint();
    const second = structuredClone(bp.context.samples[0]!);
    second.customer.firstName = "Second";
    bp.context.samples.push(second);
    expect(runAccount({ blueprint: bp }, { sampleIndex: 1 }).customer.firstName).toBe("Second");
    expect(runAccount({ blueprint: bp }, { sampleIndex: 7 })).toBe(bp.context.samples[0]);
    expect(runAccount({ blueprint: bp }, null)).toBe(bp.context.samples[0]);
  });

  it("provenance defaults: recorded vs simulated (with the §7.5 detail line); the v2 fields parse", () => {
    expect(ProvenanceStripSchema.parse(runProvenance(false))).toEqual({
      humanHalf: "recorded", transcription: { kind: "live", date: null }, aiHalf: { kind: "live", date: null }, customerInAiHalf: "recorded", detail: null,
    });
    expect(runProvenance(true)).toMatchObject({ humanHalf: "simulated", customerInAiHalf: "synthetic", detail: expect.stringContaining("Fictional people") });
    const k = fakeKernel();
    const bp = dentalBlueprint();
    const fields = relayRunFields(k.compile(bp, { versionId: "rv_a", relayId: "rly_a", hash: "h", flagship: false }), bp.context.samples[0]!, true);
    expect(UiSpecSchema.parse(fields.relay).relay.simulated).toBe(true);
    expect(fields.listening.keyterms).toContain(bp.context.samples[0]!.customer.firstName);
    expect(CreateCaseResponseV2Schema.shape.provenance.parse(fields.provenance)).toEqual(runProvenance(true));
  });

  it("the kernel binding slot: null by default (WP14a·2 not on main), settable for tests, restorable", () => {
    expect(getKernelBinding()).toBeNull();
    const k = fakeKernel();
    setKernelBinding(k);
    expect(getKernelBinding()).toBe(k);
    setKernelBinding(null);
    expect(getKernelBinding()).toBeNull();
    setKernelBinding(undefined);
    expect(getKernelBinding()).toBeNull();
  });
});
