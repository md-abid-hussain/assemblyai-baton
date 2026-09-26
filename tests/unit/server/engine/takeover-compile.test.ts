/**
 * WP14b·2, the WP5 compile port (TASKS-v2 §6 WP5, PLATFORM §4.7): a pass is compiled by the relay version its case
 * runs, and a Baton case (or a server with no kernel) still compiles through WP1. No database, fake kernel, $0.
 */
import { describe, expect, it } from "vitest";

import type { CaseState, PolicyRecord } from "@/core/contracts/case";
import type { CatalogCall, KernelBinding } from "@/core/contracts/ext/wp14b-engine";
import type { CompiledTakeover } from "@/core/contracts/takeover";
import type { AccountRecord, Blueprint, CompiledRelay, CompileTakeoverOptions } from "@/core/contracts/v2";
import { CachedRelayEngineFactory } from "@/server/engine/factory";
import type { RelayRunDeps } from "@/server/engine/run";
import { relayTakeoverCompile, type RelayCompileCase } from "@/server/engine/takeover-compile";
import type { RunVersion } from "@/server/relays/registry";
import { policy } from "../../contracts/fixtures";
import { dentalBlueprint } from "../relays/helpers";
import { armReq, drainFor, harness } from "../takeovers/_fakes";
import { fakeCompiledRelay, fakeKernel } from "./helpers";

/** The dental blueprint with a second sample, so "the sample at the sim's index" is observable. */
function twoSampleBlueprint(): Blueprint {
  const bp = dentalBlueprint();
  const second = structuredClone(bp.context.samples[0]!);
  second.customer.firstName = "Noor";
  second.org.name = "Lakeside Dental";
  bp.context.samples.push(second);
  return bp;
}

function runVersion(versionId: string, bp: Blueprint): RunVersion {
  return {
    versionId, relayId: `rly_${versionId}`, relaySlug: bp.meta.slug, version: 1, hash: `h_${versionId}`, blueprint: bp,
    flagship: false, gallery: false, origin: "user", preset: null,
  };
}

const simCall = (sampleIndex: number): CatalogCall =>
  ({
    callId: "sim_1", scenarioId: "s01", title: "Sim", source: "twilio8k", assets: null,
    simulated: true, relayVersionId: "rv_1", account: null, simCallId: "sc_1", sampleIndex, gallerySim: false,
  }) as unknown as CatalogCall;

/** The port's collaborators: the real LRU factory over one version, a catalog and a binding slot. */
function deps(o: { bp?: Blueprint; binding?: KernelBinding | null; call?: CatalogCall | null } = {}) {
  const kernel = fakeKernel();
  const bp = o.bp ?? twoSampleBlueprint();
  const map: Record<string, RunVersion> = { rv_1: runVersion("rv_1", bp) };
  const resolved: string[] = [];
  const binding = o.binding === undefined ? kernel : o.binding;
  const engine = new CachedRelayEngineFactory({
    versions: { async runVersion(id: string) { return map[id] ?? null; } },
    compiler: () => (binding ? binding.compile : null),
    legacyBlueprint: async () => null,
  });
  const d: RelayRunDeps = {
    registry: {} as RelayRunDeps["registry"],
    engine,
    catalog: { async resolve(callId: string) { resolved.push(callId); return o.call ?? null; } },
    binding: () => binding,
  };
  return { d, kernel, bp, resolved, engine };
}

const snapshot = { fields: {}, callClockMs: 1 } as unknown as CaseState;
const opts: CompileTakeoverOptions = { deployId: "test-wp14b-env", voice: "alba", keytermsEnabled: true, compiledBy: "server", payToolMode: "push" };

const relayCase = (o: Partial<RelayCompileCase> = {}): RelayCompileCase =>
  ({ id: "case_1", callId: "call_s01", policy: policy as PolicyRecord, relayVersionId: "rv_1", simCallId: null, ...o });

/** A compiled relay whose `takeover()` records the account and snapshot it was given. */
function recordingRelay(bp: Blueprint, seen: { account: AccountRecord; opts: CompileTakeoverOptions }[]): CompiledRelay {
  const base = fakeCompiledRelay(bp, { versionId: "rv_1", relayId: "rly_rv_1", hash: "h_rv_1", flagship: false });
  return {
    ...base,
    takeover: (_s, account, o) => {
      seen.push({ account, opts: o });
      return { greeting: `relay greeting for ${account.customer.firstName}`, systemPrompt: "relay prompt", promptVersion: "relay-1", stage: "collect",
        vaSessionCapMs: 200_000, keyterms: ["a"], transcriptionMode: "universal_streaming" } as unknown as CompiledTakeover;
    },
  };
}

describe("relayTakeoverCompile: which compiler runs (P§4.7)", () => {
  it("a Baton case (no relay_version_id) is null, and the engine is never asked", async () => {
    const { d, kernel } = deps();
    expect(await relayTakeoverCompile(() => d)({ case: relayCase({ relayVersionId: null }), snapshot, opts })).toBeNull();
    expect(kernel.compiles).toHaveLength(0);
  });

  it("no kernel bound throws (WP14b·3): a Dental case exists now, and Baton's prompt for it would be wrong", async () => {
    const { d, kernel } = deps({ binding: null });
    await expect(relayTakeoverCompile(() => d)({ case: relayCase(), snapshot, opts })).rejects.toMatchObject({ code: "E_MAINTENANCE" });
    expect(kernel.compiles).toHaveLength(0);
  });

  it("…but a Baton case is still null with no kernel, so the flagship keeps compiling through WP1 (parity)", async () => {
    const { d } = deps({ binding: null });
    expect(await relayTakeoverCompile(() => d)({ case: relayCase({ relayVersionId: null }), snapshot, opts })).toBeNull();
  });

  it("an unknown version throws instead of falling back: a Baton compile of another relay would be a wrong prompt", async () => {
    const { d } = deps();
    await expect(relayTakeoverCompile(() => d)({ case: relayCase({ relayVersionId: "rv_none" }), snapshot, opts })).rejects.toMatchObject({ code: "E_NOT_FOUND" });
  });
});

describe("relayTakeoverCompile: the account the pass speaks to", () => {
  it("a recorded call speaks to the case's policy through the kernel's policyToAccount, and the opts pass through", async () => {
    const { d, kernel, bp } = deps();
    const seen: { account: AccountRecord; opts: CompileTakeoverOptions }[] = [];
    d.engine = { forVersion: async () => recordingRelay(bp, seen) } as unknown as RelayRunDeps["engine"];
    const out = await relayTakeoverCompile(() => d)({ case: relayCase(), snapshot, opts });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.account).toEqual(kernel.policyToAccount(policy as PolicyRecord));
    expect(seen[0]!.opts).toBe(opts);
    expect(out!.greeting).toBe(`relay greeting for ${(policy as PolicyRecord).policyholder.firstName}`);
  });

  it("a simulated call speaks to the RUN version's sample at the sim's index (a preset keeps its own numbers)", async () => {
    const { d, bp, resolved } = deps({ call: simCall(1) });
    const seen: { account: AccountRecord; opts: CompileTakeoverOptions }[] = [];
    d.engine = { forVersion: async () => recordingRelay(bp, seen) } as unknown as RelayRunDeps["engine"];
    await relayTakeoverCompile(() => d)({ case: relayCase({ callId: "sim_1", simCallId: "sc_1" }), snapshot, opts });
    expect(resolved).toEqual(["sim_1"]);
    expect(seen[0]!.account.customer.firstName).toBe("Noor");
    expect(seen[0]!.account.org.name).toBe("Lakeside Dental");
  });

  it("a sim the catalog no longer resolves falls back to sample 0, never to the policy", async () => {
    const { d, bp } = deps({ call: null });
    const seen: { account: AccountRecord; opts: CompileTakeoverOptions }[] = [];
    d.engine = { forVersion: async () => recordingRelay(bp, seen) } as unknown as RelayRunDeps["engine"];
    await relayTakeoverCompile(() => d)({ case: relayCase({ callId: "sim_1", simCallId: "sc_1" }), snapshot, opts });
    expect(seen[0]!.account.customer.firstName).toBe("Maya");
  });

  it("a simulated case whose compiled relay carries no blueprint is an E_INTERNAL, not a wrong account", async () => {
    const { d, bp } = deps({ call: simCall(0) });
    const seen: { account: AccountRecord; opts: CompileTakeoverOptions }[] = [];
    d.engine = { forVersion: async () => ({ ...recordingRelay(bp, seen), blueprint: null }) } as unknown as RelayRunDeps["engine"];
    await expect(relayTakeoverCompile(() => d)({ case: relayCase({ callId: "sim_1", simCallId: "sc_1" }), snapshot, opts })).rejects.toMatchObject({ code: "E_INTERNAL" });
  });

  it("the version compiles once through the LRU and the real factory reaches the kernel with the version's blueprint", async () => {
    const { d, kernel } = deps();
    const p = relayTakeoverCompile(() => d);
    await p({ case: relayCase(), snapshot, opts });
    await p({ case: relayCase({ id: "case_2" }), snapshot, opts });
    expect(kernel.compiles).toEqual([{ versionId: "rv_1", relayId: "rly_rv_1", hash: "h_rv_1", flagship: false }]);
  });
});

describe("TakeoverService.compile through the port (#11)", () => {
  it("a relay case compiles through its version: WP1 is not called, the first update is still validated, the row records the version", async () => {
    const seen: { case: RelayCompileCase; snapshot: CaseState }[] = [];
    const h = harness({
      relayCompile: async ({ case: c, snapshot: s }) => {
        seen.push({ case: c, snapshot: s });
        return { greeting: "relay greeting", systemPrompt: "relay prompt", promptVersion: "relay-1", stage: "collect", vaSessionCapMs: 210_000,
          keyterms: ["deposit"], transcriptionMode: "universal_streaming" } as unknown as CompiledTakeover;
      },
    });
    h.store.addCase({ id: "case_1", relayVersionId: "rv_1", simCallId: "sc_1" });
    const { takeoverId } = await h.svc.arm(armReq());
    const c = await h.svc.compile(takeoverId, drainFor(61_234.5));
    expect(c.greeting).toBe("relay greeting");
    expect(h.calls.compile).toHaveLength(0); // WP1's compiler never ran
    expect(h.calls.validate).toHaveLength(1); // the first update is still validated before it leaves the server
    expect(seen[0]!.case).toMatchObject({ id: "case_1", relayVersionId: "rv_1", simCallId: "sc_1" });
    expect(seen[0]!.snapshot.callClockMs).toBe(61_234.5);
    const row = h.store.rows.get(takeoverId)!;
    expect(row.greeting).toBe("relay greeting");
    expect((row.protocol.compile as { relayVersionId: string | null }).relayVersionId).toBe("rv_1");
  });

  it("a Baton case keeps WP1's compiler and records no version, even with the port bound", async () => {
    const h = harness({ relayCompile: async () => null });
    h.store.addCase({ id: "case_1" });
    const { takeoverId } = await h.svc.arm(armReq());
    await h.svc.compile(takeoverId, drainFor(61_234.5));
    expect(h.calls.compile).toHaveLength(1);
    expect((h.store.rows.get(takeoverId)!.protocol.compile as { relayVersionId: string | null }).relayVersionId).toBeNull();
  });
});
