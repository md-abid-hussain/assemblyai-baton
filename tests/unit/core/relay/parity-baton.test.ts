/**
 * The Baton compile PARITY suite (PLATFORM §4.6): data/relays/baton-add-driver.json, compiled by the kernel,
 * reproduces the legacy oracle (tests/fixtures/relay-parity/baton/*.json, written by scripts/relay/snapshot-legacy.ts
 * from the legacy code) with 0 diffs. This file reads only the fixtures and the kernel, so the proof survives the
 * deletion of the legacy compiler.
 *
 * Allowed differences (listed, not silent): `promptVersion` = `relay:<hash8>`; `compiledBy` and the takeover
 * `snapshot` are unchanged.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { CaseState, FieldState, PolicyRecord, Readiness, Stage } from "@/core/contracts";
import { BlueprintSchema } from "@/core/contracts/v2";
import { emptyCaseState } from "@/core/case/state";
import { sha256Hex } from "@/core/case/sha256";
import { buildFirstUpdate } from "@/core/compiler/first-update";
import { policyToAccount, type BatonRating } from "@/core/relay/account";
import { compileRelay } from "@/core/relay/compile";
import { lintBlueprintJson } from "@/core/relay/lint";
import { hash8 } from "@/core/relay/migrate";

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const DIR = join(ROOT, "tests", "fixtures", "relay-parity", "baton");
const load = <T,>(name: string): T => JSON.parse(readFileSync(join(DIR, name), "utf8")) as T;

type Compact = Record<string, [FieldState["status"], string | null, FieldState["source"], string | null]>;
interface Snap { id: string; scenario: string; caseId: string; readiness: Readiness; fields: Compact }
interface Named extends Snap {
  greeting: unknown; caseJson: string; prompts: Record<Stage, string>; firstUpdates: Record<"confirm" | "disclose", unknown>;
  takeover: { stage: Stage; transcriptionMode: string; vaSessionCapMs: number; voice: string; keyterms: string[] };
  nextStep: unknown; values: Record<string, string>; disclosures: Record<string, unknown>;
}
interface Random extends Snap {
  greeting: { text: string; asserted: string[] }; caseJson: string; promptSha: Record<Stage, string>; capMs: number; transcriptionMode: string;
  values: Record<string, string>; disclosureSha: string;
}
interface Static {
  policies: Record<string, PolicyRecord>; ratings: Record<string, BatonRating>; listeningKeyterms: Record<string, string[]>;
  tools: Record<Stage, unknown[]>; extractor: { prompt: string; format: unknown; versionId: string };
  nextStageTable: { current: Stage | null; ready: boolean; esign: boolean; paid: boolean; next: Stage }[];
}

const meta = load<{ deployId: string; promptVersion: string; greetingMaxWords: number; counts: { named: number; random: number } }>("meta.json");
const stat = load<Static>("static.json");
const named = load<Named[]>("named.json");
const random = load<Random[]>("random.json");
const phrases = load<{ snapshots: Record<string, Compact>; phrases: { snapshot: string; field: string; kind: "ask" | "confirm"; value?: string; raw?: string | null; text: string }[] }>("phrases.json");
const normalize = load<{ scenario: string; field: string; raw: string; result: { norm: string; display: string } | null; spokenForms: string[] | null; display: string | null }[]>("normalize.json");
const extractorInputs = load<{ state: string; from: number; input: string }[]>("extractor-inputs.json");
const dialog = JSON.parse(readFileSync(join(ROOT, "tests", "fixtures", "extract", "s01-dialog.json"), "utf8")) as {
  callDate: string; turns: { turnId: string; channel: "rep" | "customer"; text: string }[];
};

const batonJson = JSON.parse(readFileSync(join(ROOT, "data", "relays", "baton-add-driver.json"), "utf8")) as unknown;
const bp = BlueprintSchema.parse(batonJson);
const kernel = compileRelay(bp, { flagship: true });
const STAGES: Stage[] = ["confirm", "disclose", "pay", "close"];

function rebuild(caseId: string, readiness: Readiness | null, fields: Compact): CaseState {
  const st = emptyCaseState(caseId);
  for (const [f, [status, value, source, display]] of Object.entries(fields)) {
    (st.fields as unknown as Record<string, FieldState>)[f] = {
      field: f as FieldState["field"], status, reason: status === "VERIFIED" ? "acknowledged" : status === "PENDING" ? "stated_once" : "absent",
      value, display, source, evidence: [], conflict: null, flags: [], updatedAtMs: 0,
    };
  }
  if (readiness) st.readiness = readiness;
  return st;
}
const accountOf = (scenario: string) => policyToAccount(stat.policies[scenario]!, stat.ratings[scenario]);
const snapState = (s: Snap) => rebuild(s.caseId, s.readiness, s.fields);
const words = (s: string) => s.trim().split(/\s+/).filter(Boolean);

describe("Baton blueprint", () => {
  it("parses and lints clean", () => {
    const r = lintBlueprintJson(batonJson);
    expect(r.issues).toEqual([]);
    expect(r.blueprint).not.toBeNull();
  });
  it("the oracle covers the corpus", () => {
    expect(meta.counts).toEqual({ named: named.length, random: random.length });
    expect(random.length).toBe(200);
    expect(named.length).toBeGreaterThanOrEqual(9 + 4);
  });
  it("carries the recorded handoff line and accepts both wordings", () => {
    expect(bp.handoff.repLine).toBe("OK if my assistant finishes the paperwork? I'll be one tap away if you need me.");
    expect(bp.handoff.repLinePatterns.length).toBeGreaterThanOrEqual(2);
  });
});

describe("parity: greeting (named + 200 random snapshots)", () => {
  it("named snapshots: GreetingResult deep-equal", () => {
    for (const s of named) expect(kernel.greeting(snapState(s), accountOf(s.scenario)), s.id).toEqual(s.greeting);
  });
  it("random snapshots: GreetingResult deep-equal, ≤ 40 words, the first fact by word 24", () => {
    for (const s of random) {
      const g = kernel.greeting(snapState(s), accountOf(s.scenario));
      expect(g, s.id).toEqual(s.greeting);
      expect(g.wordCount, `${s.id}: ${g.text}`).toBeLessThanOrEqual(meta.greetingMaxWords);
      // Acceptance 6: the summary (the inherited facts) starts within the first 24 words.
      expect(words(g.text).indexOf("adding"), s.id).toBeLessThan(24);
    }
  });
  it("named snapshots: ≤ 40 words", () => {
    for (const s of named) expect((s.greeting as { wordCount: number }).wordCount, s.id).toBeLessThanOrEqual(40);
  });
});

describe("parity: prompt, case JSON, tools, first update", () => {
  it("case JSON equal (named + random)", () => {
    for (const s of [...named, ...random]) expect(kernel.caseJson(snapState(s), accountOf(s.scenario)), s.id).toBe(s.caseJson);
  });
  it("prompt text equal at every stage (push mode, incl. the deploy marker line)", () => {
    for (const s of named) {
      for (const stage of STAGES) expect(kernel.prompt(snapState(s), accountOf(s.scenario), stage, { deployId: meta.deployId }), `${s.id}/${stage}`).toBe(s.prompts[stage]);
    }
    for (const s of random) {
      for (const stage of STAGES) expect(sha256Hex(kernel.prompt(snapState(s), accountOf(s.scenario), stage, { deployId: meta.deployId })), `${s.id}/${stage}`).toBe(s.promptSha[stage]);
    }
  });
  it("tools per stage deep-equal (built-ins + confirm tool + connectors)", () => {
    for (const stage of STAGES) expect(kernel.tools(stage), stage).toEqual(stat.tools[stage]);
  });
  it("first session.update deep-equal (confirm and disclose, keyterms on)", () => {
    for (const s of named) {
      for (const stage of ["confirm", "disclose"] as const) {
        const c = kernel.takeover(snapState(s), accountOf(s.scenario), { deployId: meta.deployId, keytermsEnabled: true, stage });
        expect(buildFirstUpdate(c), `${s.id}/${stage}`).toEqual(s.firstUpdates[stage]);
      }
    }
  });
  it("takeover: initial stage, input mode, session cap, voice; promptVersion is relay:<hash8> (the listed difference)", () => {
    for (const s of named) {
      const c = kernel.takeover(snapState(s), accountOf(s.scenario), { deployId: meta.deployId });
      expect({ stage: c.stage, transcriptionMode: c.transcriptionMode, vaSessionCapMs: c.vaSessionCapMs, voice: c.voice, keyterms: c.keyterms }, s.id).toEqual(s.takeover);
      expect(c.promptVersion).toBe(`relay:${hash8(kernel.hash)}`);
      expect(c.compiledBy).toBe("server");
    }
    for (const s of random) {
      const c = kernel.takeover(snapState(s), accountOf(s.scenario), { deployId: meta.deployId });
      expect([c.vaSessionCapMs, c.transcriptionMode], s.id).toEqual([s.capMs, s.transcriptionMode]);
    }
  });
  it("nextStage truth table equal", () => {
    for (const r of stat.nextStageTable) {
      const s = {
        readiness: { verified: 0, pending: 0, missing: 0, requiredTotal: 10, ready: r.ready },
        disclosuresGiven: r.esign ? (["premium_change", "esign_consent"] as ("premium_change" | "esign_consent")[]) : [],
        payment: r.paid ? { id: "pay_1", status: "succeeded" as const, amountCents: 100, provider: "mock" as const, checkoutUrl: null, esignId: null, updatedAtMs: 0 } : null,
        connectorsSucceeded: [],
      };
      expect(kernel.nextStage(r.current, s as never), JSON.stringify(r)).toBe(r.next);
    }
  });
});

describe("parity: disclosures and named values", () => {
  it("named snapshots: both disclosures × tax suffix off/on, and the money values", () => {
    for (const s of named) {
      const st = snapState(s);
      const account = accountOf(s.scenario);
      const v = kernel.values({ snapshot: st, account });
      expect({ monthly_premium: v.monthly_premium, due_today: v.due_today }, s.id).toEqual(s.values);
      for (const kind of ["premium_change", "esign_consent"]) {
        for (const taxSuffix of [false, true]) {
          expect(kernel.disclosure(kind, { snapshot: st, account, opts: { taxSuffix } }), `${s.id}/${kind}/${taxSuffix}`).toEqual(s.disclosures[`${kind}${taxSuffix ? "+tax" : ""}`]);
        }
      }
    }
  });
  it("random snapshots: disclosures (sha) and values", () => {
    for (const s of random) {
      const st = snapState(s);
      const account = accountOf(s.scenario);
      const v = kernel.values({ snapshot: st, account });
      expect({ monthly_premium: v.monthly_premium, due_today: v.due_today }, s.id).toEqual(s.values);
      const out: Record<string, unknown> = {};
      for (const kind of ["premium_change", "esign_consent"]) for (const taxSuffix of [false, true]) out[`${kind}${taxSuffix ? "+tax" : ""}`] = kernel.disclosure(kind, { snapshot: st, account, opts: { taxSuffix } });
      expect(sha256Hex(JSON.stringify(out)), s.id).toBe(s.disclosureSha);
    }
  });
});

describe("parity: extractor (PLATFORM §5)", () => {
  it("prompt, strict format and version id equal (EXTRACTOR_VERSION_V3)", () => {
    expect(kernel.extractor.prompt).toBe(stat.extractor.prompt);
    expect(kernel.extractor.format).toEqual(stat.extractor.format);
    expect(JSON.stringify(kernel.extractor.format.schema)).toBe(JSON.stringify((stat.extractor.format as { schema: unknown }).schema));
    expect(kernel.extractor.versionId).toBe(stat.extractor.versionId);
  });
  it("user input strings equal on the WP3 s01 dialog at 3 pass points", () => {
    const states = new Map(named.filter((s) => s.id.startsWith("s01")).map((s) => [s.id, s]));
    expect(extractorInputs.length).toBeGreaterThan(0);
    for (const x of extractorInputs) {
      const s = states.get(x.state)!;
      const input = kernel.extractor.buildInput({
        callDate: dialog.callDate, account: accountOf("s01"), state: snapState(s),
        recent: dialog.turns.slice(0, x.from), newTurns: dialog.turns.slice(x.from, x.from + 3),
      });
      expect(input, `${x.state}@${x.from}`).toBe(x.input);
    }
  });
});

describe("parity: field semantics (spec)", () => {
  it("normalize, display and spoken forms equal on every scenario value and say_it", () => {
    for (const n of normalize) {
      const account = accountOf(n.scenario);
      const r = kernel.spec.normalize(n.field, n.raw, { callDate: account.callDate, account });
      expect(r, `${n.scenario}/${n.field}: ${n.raw}`).toEqual(n.result);
      if (r) {
        expect(kernel.spec.spokenForms(n.field, r.norm, account), `${n.field}=${r.norm}`).toEqual(n.spokenForms);
        expect(kernel.spec.display(n.field, r.norm, account, n.raw)).toBe(n.display);
      }
    }
  });
  it("confirm and ask phrases: every field × enum value × {verified name, no name} × raw words", () => {
    const account = accountOf("s01");
    for (const p of phrases.phrases) {
      const snapshot = rebuild(`case_phr_${p.snapshot}`, null, phrases.snapshots[p.snapshot]!);
      const text = p.kind === "ask"
        ? kernel.spec.askPhrase(p.field, { account, snapshot })
        : kernel.spec.confirmPhrase(p.field, p.value!, { account, snapshot, raw: p.raw ?? null });
      expect(text, JSON.stringify(p)).toBe(p.text);
    }
  });
  it("listening keyterms equal keytermsFromPolicy for all 22 scenarios", () => {
    for (const [id, terms] of Object.entries(stat.listeningKeyterms)) expect(kernel.listening(accountOf(id)).keyterms, id).toEqual(terms);
  });
});
