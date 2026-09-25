import { describe, expect, it } from "vitest";
import type { Blueprint } from "@/core/contracts/v2";
import { hasLintErrors, lintBlueprint, lintBlueprintJson } from "@/core/relay/lint";
import { parseTemplate, renderTemplate, type PathRef, type RenderScope } from "@/core/relay/template";
import { miniBlueprint } from "./fixtures/mini-blueprint";

const codes = (bp: Blueprint) => lintBlueprint(bp).map((i) => i.code);
const issues = (bp: Blueprint, code: string) => lintBlueprint(bp).filter((i) => i.code === code);

/** Each case mutates a fresh mini blueprint so that exactly one rule fails. */
const FAIL_CASES: [string, string, (bp: Blueprint) => void][] = [
  // L1
  ["L1 stage id reused by a disclosure", "L1", (bp) => { bp.playbook.stages[1]!.id = "deposit_terms"; }],
  ["L1 stage id reused by a connector", "L1", (bp) => { bp.playbook.stages[0]!.id = "deposit_link"; }],
  ["L1 tool name clashes with a built-in", "L1", (bp) => { const c = bp.connectors[2]!; if (c.type === "http_action") c.toolName = "get_disclosure"; }],
  ["L1 duplicate enum value", "L1", (bp) => { bp.fields[3]!.enumValues![1]!.value = "new_patient"; }],
  // L2
  ["L2 normalizer does not fit the type", "L2", (bp) => { bp.fields[0]!.normalizer = "us_zip5"; }],
  ["L2 enum without enumValues", "L2", (bp) => { delete bp.fields[3]!.enumValues; }],
  ["L2 enumValues on a non-enum", "L2", (bp) => { bp.fields[0]!.enumValues = [{ value: "aa", label: "A", synonyms: [], spokenForms: [] }]; }],
  ["L2 lookup on an unknown table", "L2", (bp) => { bp.fields[2]!.lookup!.table = "prices"; }],
  ["L2 lookup match column missing", "L2", (bp) => { bp.fields[2]!.lookup!.matchColumns = ["name"]; }],
  ["L2 money field with a text normalizer", "L2", (bp) => { bp.fields[0]!.type = "money"; bp.fields[0]!.normalizer = "text"; }],
  ["L2 table labelColumn missing", "L2", (bp) => { bp.context.tables[0]!.labelColumn = "title"; }],
  // L3
  ["L3 template does not parse", "L3", (bp) => { bp.fields[0]!.phrases.ask = "the {name"; }],
  ["L3 unknown fact", "L3", (bp) => { bp.playbook.greeting.optOut = "Call {fact.nope} anytime."; }],
  ["L3 unknown formatter", "L3", (bp) => { bp.fields[1]!.phrases.confirm = "on {f.appointment_date|fancy_date}"; }],
  ["L3 unknown field in a condition", "L3", (bp) => { bp.playbook.stages[1]!.goal = "{?f.ghost.verified}x{/?}Read it."; }],
  ["L3 unknown option", "L3", (bp) => { bp.playbook.disclosures[0]!.text += "{?opt.vat}x{/?}"; }],
  ["L3 enum condition value", "L3", (bp) => { bp.playbook.stages[0]!.goal = "{?f.visit_kind=vip}x{/?}Confirm."; }],
  ["L3 clause outside the summary", "L3", (bp) => { bp.playbook.greeting.optOut = "Say Sam{clause.date}."; }],
  ["L3 phrase.confirm outside next.confirm", "L3", (bp) => { bp.playbook.greeting.next.ask = "I need {phrase.confirm}."; }],
  ["L3 case.json outside the prompt", "L3", (bp) => { bp.playbook.stages[0]!.goal = "Use {case.json}."; }],
  ["L3 unknown value in a disclosure", "L3", (bp) => { bp.playbook.disclosures[0]!.criticalTokens = ["{v.nope}"]; }],
  ["L3 unknown clause", "L3", (bp) => { bp.playbook.greeting.summary = "{clause.vehicle}."; }],
  ["L3 bad context keyterm table column", "L3", (bp) => { bp.listening.contextKeyterms = ["table.treatments.price"]; }],
  ["L3 unknown vaKeyterm field", "L3", (bp) => { bp.playbook.vaKeyterms = ["f.ghost"]; }],
  ["L3 bad caseJson header path", "L3", (bp) => { bp.playbook.caseJson.header = [{ key: "x", from: "fact.ghost" }]; }],
  ["L3 value lookup keyField", "L3", (bp) => { const r = bp.values[0]!.ref; if (r.kind === "lookup") r.keyField = "ghost"; }],
  ["L3 exit names an unknown disclosure", "L3", (bp) => { bp.playbook.stages[1]!.exit = { kind: "disclosure_accepted", disclosure: "ghost" }; }],
  ["L3 confirmation requires an unknown connector", "L3", (bp) => { const c = bp.connectors[1]!; if (c.type === "confirmation") c.requires = ["ghost"]; }],
  ["L3 requireVerified unknown field", "L3", (bp) => { bp.handoff.allowedWhen.requireVerified = ["ghost"]; }],
  // G1
  ["G1 unguarded field in the summary", "G1", (bp) => { bp.playbook.greeting.summary = "I have the {f.treatment.display} booking{clause.date}."; }],
  ["G1 guard for another field", "G1", (bp) => { bp.playbook.greeting.clauses[0]!.text = "{?f.patient_name.verified} on {f.appointment_date|spoken_date}{/?}"; }],
  ["G1 pending guard is not enough", "G1", (bp) => { bp.playbook.greeting.clauses[0]!.text = "{?f.appointment_date.known} on {f.appointment_date|spoken_date}{/?}"; }],
  ["G1 unguarded field in the subject", "G1", (bp) => { bp.playbook.subject = "{f.patient_name|first_name}"; }],
  ["G1 field in next.confirm", "G1", (bp) => { bp.playbook.greeting.next.confirm = "Can you confirm {f.appointment_date}?"; }],
  // C1
  ["C1 opening without the AI disclosure", "C1", (bp) => { bp.playbook.greeting.opening = "Hi {customer.firstName}, this call is recorded."; }],
  ["C1 opening without the recording notice", "C1", (bp) => { bp.playbook.greeting.opening = "Hi {customer.firstName}, I'm {org.name}'s AI assistant, not a person."; }],
  // S1
  ["S1 stage order", "S1", (bp) => { const [a, b] = bp.playbook.stages; bp.playbook.stages[0] = b!; bp.playbook.stages[1] = a!; }],
  ["S1 repeated stage kind", "S1", (bp) => { bp.playbook.stages[1]!.kind = "confirm"; }],
  ["S1 stage without hand_back_to_rep", "S1", (bp) => { bp.playbook.stages[3]!.tools = ["send_confirmation", "update_case_field"]; }],
  ["S1 unknown tool", "S1", (bp) => { bp.playbook.stages[3]!.tools.push("send_fax"); }],
  ["S1 get_disclosure without disclosures", "S1", (bp) => {
    bp.playbook.disclosures = [];
    bp.playbook.stages[1]!.exit = { kind: "end" };
    const c = bp.connectors[0]!; if (c.type === "payment_link") c.requiresDisclosure = null;
  }],
  ["S1 duplicate tool", "S1", (bp) => { bp.playbook.stages[0]!.tools.push("update_case_field"); }],
  // X3 (lintBlueprint re-checks even an object that skipped BlueprintSchema)
  ["X3 nested quantifier in a QA pattern", "X3", (bp) => { bp.fields[0]!.qa.ask = ["(a+)+$"]; }],
  ["X3 lookahead in an enum synonym", "X3", (bp) => { bp.fields[3]!.enumValues![0]!.synonyms = ["(?=new)new"]; }],
  ["X3 backreference in a rep-line pattern", "X3", (bp) => { bp.handoff.repLinePatterns = ["(hand) you\\1"]; }],
  ["X3 unsafe tool pattern", "X3", (bp) => { const c = bp.connectors[2]!; if (c.type === "http_action") c.params.properties.ref_code!.pattern = "(a|ab)*c"; }],
];

describe("lint skeleton (L1, L2, L3, G1, C1, S1, X3)", () => {
  it("the mini fixture lints clean", () => {
    expect(lintBlueprint(miniBlueprint())).toEqual([]);
  });

  it.each(FAIL_CASES)("%s", (_name, code, mutate) => {
    const bp = miniBlueprint();
    mutate(bp);
    const got = lintBlueprint(bp);
    expect(got.length).toBeGreaterThan(0);
    expect(new Set(got.map((i) => i.code))).toEqual(new Set([code]));
    expect(hasLintErrors(got)).toBe(true);
    for (const i of got) expect(i.path.length).toBeGreaterThan(0);
  });

  it("G1 accepts the else branch of a negated guard and {?f.X.rep}", () => {
    const bp = miniBlueprint();
    bp.playbook.greeting.clauses[0]!.text = "{?!f.appointment_date.verified}{:} on {f.appointment_date|spoken_date}{/?}";
    bp.playbook.greeting.summary = "{?f.treatment.rep}I have the {f.treatment.display} booking{/?}{clause.date}.";
    expect(codes(bp)).toEqual([]);
  });

  it("C1 renders the opening with the first sample", () => {
    const bp = miniBlueprint();
    bp.compliance.aiDisclosurePatterns = ["Brightwater Dental's AI assistant", "not a person"];
    expect(codes(bp)).toEqual([]);
    bp.context.samples[0]!.org.name = "Other Clinic";
    expect(issues(bp, "C1")[0]?.message).toContain("Other Clinic");
  });

  it("the lint pass never throws on odd but parseable input", () => {
    const bp = miniBlueprint();
    bp.playbook.greeting.opening = "{?f.ghost.verified}{f.ghost}{/?}";
    expect(() => lintBlueprint(bp)).not.toThrow();
  });
});

describe("G1 property: a G1-clean greeting never states a non-VERIFIED value (500 seeded snapshots)", () => {
  const STATUSES = ["VERIFIED", "PENDING", "MISSING"] as const;
  it("holds for the mini greeting", () => {
    const bp = miniBlueprint();
    expect(lintBlueprint(bp).filter((i) => i.code === "G1")).toEqual([]);
    const tpl = (src: string) => parseTemplate(src);
    const g = bp.playbook.greeting;
    const subject = tpl(bp.playbook.subject);
    const clauses = new Map(g.clauses.map((c) => [c.id, tpl(c.text)]));
    const parts = [g.opening, g.summary, g.optOut].map(tpl);
    let seed = 1234567;
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    for (let n = 0; n < 500; n++) {
      const status = Object.fromEntries(bp.fields.map((f) => [f.id, STATUSES[Math.floor(rand() * 3)]!]));
      const marker = (id: string) => `<<${id}>>`;
      const scope: RenderScope = {
        resolve: (ref: PathRef): string | null => {
          if (ref.kind === "field") return status[ref.id] === "MISSING" ? null : marker(ref.id);
          if (ref.kind === "subject") return renderTemplate(subject, scope);
          if (ref.kind === "clause") return renderTemplate(clauses.get(ref.id) ?? [], scope);
          return ref.kind === "customer" || ref.kind === "org" ? "X" : null;
        },
        test: (c) => c.kind === "field_status" && (
          c.status === "verified" || c.status === "rep" ? status[c.field] === "VERIFIED"
            : c.status === "pending" ? status[c.field] === "PENDING"
              : c.status === "missing" ? status[c.field] === "MISSING" : status[c.field] !== "MISSING"),
        format: (_f, v) => v,
      };
      const text = parts.map((p) => renderTemplate(p, scope)).join(" ");
      for (const f of bp.fields) if (status[f.id] !== "VERIFIED") expect(text).not.toContain(marker(f.id));
    }
  });
});

describe("lintBlueprintJson: schema issues and X3", () => {
  it("maps an unsafe regex to X3 naming the group", () => {
    const json = miniBlueprint() as unknown as { fields: { qa: { ask: string[] } }[] };
    json.fields[0]!.qa.ask = ["^(a|ab)*c$"];
    const r = lintBlueprintJson(json);
    expect(r.blueprint).toBeNull();
    expect(r.issues).toHaveLength(1);
    expect(r.issues[0]).toMatchObject({ code: "X3", severity: "error", path: ["fields", 0, "qa", "ask", 0] });
    expect(r.issues[0]!.message).toContain("\"(a|ab)\"");
  });

  it("maps an unsafe tool pattern to X3", () => {
    const json = miniBlueprint() as unknown as { connectors: { params?: { properties: Record<string, { pattern?: string }> } }[] };
    json.connectors[2]!.params!.properties.ref_code!.pattern = "(\\d+)+";
    const r = lintBlueprintJson(json);
    expect(r.issues.map((i) => i.code)).toEqual(["X3"]);
    expect(r.issues[0]!.message).toContain("tool pattern");
  });

  it("maps other schema failures to SCHEMA with a path", () => {
    const json = miniBlueprint() as unknown as { playbook: { greeting: { maxWords: number } } };
    json.playbook.greeting.maxWords = 55;
    const r = lintBlueprintJson(json);
    expect(r.issues).toEqual([expect.objectContaining({ code: "SCHEMA", path: ["playbook", "greeting", "maxWords"] })]);
  });

  it("returns the parsed blueprint and lint for valid JSON", () => {
    const r = lintBlueprintJson(JSON.parse(JSON.stringify(miniBlueprint())));
    expect(r.blueprint?.meta.slug).toBe("mini-dental");
    expect(r.issues).toEqual([]);
  });
});
