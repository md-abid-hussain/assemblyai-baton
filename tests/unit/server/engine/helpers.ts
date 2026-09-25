/**
 * WP14b·2 engine fixtures: a fake WP14a kernel binding (WP14a·2's `compileRelay` is not on main yet), so the server
 * wiring (factory, catalog, compiled view, `/api/cases` relay runs) is tested against the `CompiledRelay` contract.
 * The fake is deterministic and records every compile.
 */
import type { CaseState, PolicyRecord } from "@/core/contracts/case";
import type { KernelBinding, RelayCompileOptions } from "@/core/contracts/ext/wp14b-engine";
import {
  STAGE_KIND_TO_STAGE, type AccountRecord, type Blueprint, type CannedState, type CompiledRelay, type IntentSpec,
} from "@/core/contracts/v2";

export interface FakeKernel extends KernelBinding {
  compiles: RelayCompileOptions[];
  /** Makes `takeover()` throw (the compiled view's firstUpdate failure path). */
  failFirstUpdate: boolean;
}

export function fakeCompiledRelay(bp: Blueprint, opts: RelayCompileOptions, k?: { failFirstUpdate: boolean }): CompiledRelay {
  const stages = bp.playbook.stages.map((s) => ({ kind: STAGE_KIND_TO_STAGE[s.kind], label: s.label }));
  const compiled: CompiledRelay = {
    versionId: opts.versionId,
    hash: opts.hash,
    blueprint: bp,
    spec: { id: bp.meta.slug, hash: opts.hash } as unknown as IntentSpec,
    ui: {
      relay: { id: opts.relayId, versionId: opts.versionId, slug: bp.meta.slug, title: bp.meta.title, flagship: opts.flagship, simulated: false },
      fields: bp.fields.map((f) => ({
        id: f.id, label: f.label, required: f.required, group: f.ui.group, hidden: f.ui.hidden, type: f.type, repOnly: f.setBy === "rep_only", advice: f.adviceDomain,
      })),
      stages,
      disclosures: bp.playbook.disclosures.map((d) => ({ id: d.id, title: d.title })),
      connectors: [],
      phone: { payment: false, esign: false, smsSender: "Changeover" },
    },
    listening: (a: AccountRecord) => ({ keyterms: [a.customer.firstName, a.org.name], prompt: "", languageCodes: ["en"], tuning: "telephony_8k" }),
    extractor: {
      prompt: `extract ${bp.meta.slug}`,
      format: {
        name: `${bp.meta.slug.replace(/-/g, "_")}_patch`, strict: true,
        schema: { type: "object", additionalProperties: false, required: ["events"], properties: { events: { type: "array", items: { type: "string" } } } },
      },
      versionId: `x-${opts.hash.slice(0, 8)}`,
      buildInput: () => "{}",
    },
    greeting: (snap, a) => {
      const n = Object.keys(snap.fields).length;
      const text = `Hi ${a.customer.firstName}, I'm ${a.org.repFirstName}'s AI assistant. ${n} fields.`;
      return { text, wordCount: text.split(/\s+/).length, asserted: [], asks: null, confirms: null, nextStep: { kind: "none", field: null }, dropped: [] };
    },
    prompt: (_s, a, stage, o) => `[${o.deployId}] ${bp.meta.title} ${stage} for ${a.customer.firstName}`,
    tools: () => [],
    disclosure: (id) => ({ kind: id, text: "", criticalTokens: [] }),
    values: () => ({}),
    nextStage: () => "confirm",
    takeover: () => {
      if (k?.failFirstUpdate) throw new Error("E_VA_CONFIG: tool name not allowed");
      return {} as ReturnType<CompiledRelay["takeover"]>;
    },
  };
  return compiled;
}

export function fakeKernel(): FakeKernel {
  const k: FakeKernel = {
    kernelVersion: "kernel-test",
    compiles: [],
    failFirstUpdate: false,
    compile(bp, opts) {
      k.compiles.push(opts);
      return fakeCompiledRelay(bp, opts, k);
    },
    policyToAccount(p: PolicyRecord): AccountRecord {
      return {
        customer: { firstName: p.policyholder.firstName, lastName: p.policyholder.lastName, phoneLast4: p.phoneOnFileLast4 },
        org: { name: p.agencyName, repFirstName: p.repFirstName },
        callDate: p.callDate,
        facts: { policy_number: p.policyNumber },
        tables: {},
      };
    },
    cannedSnapshot(compiled: CompiledRelay, _a: AccountRecord, state: CannedState): CaseState {
      const ids = compiled.ui.fields.map((f) => f.id);
      const keep = state === "nothing" ? 0 : state === "all_verified" ? ids.length : Math.max(0, ids.length - 1);
      return { fields: Object.fromEntries(ids.slice(0, keep).map((id) => [id, { status: "verified" }])) } as unknown as CaseState;
    },
  };
  return k;
}
