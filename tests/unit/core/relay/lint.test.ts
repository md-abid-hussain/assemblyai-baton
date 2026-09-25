import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BlueprintSchema, CANNED_STATES, type Blueprint } from "@/core/contracts/v2";
import { cannedCaseState, cannedFocusField, cannedSnapshot } from "@/core/relay/canned";
import { compileRelay } from "@/core/relay/compile";
import { LINT_CODES } from "@/core/contracts/v2";
import { greetingFirstFactWord, hasLintErrors, LINT_RULES_PENDING, lintBlueprint, lintBlueprintJson } from "@/core/relay/lint";
import { parseTemplate, renderTemplate, type PathRef, type RenderScope } from "@/core/relay/template";
import { miniBlueprint } from "./fixtures/mini-blueprint";

const codes = (bp: Blueprint) => lintBlueprint(bp).map((i) => i.code);
const issues = (bp: Blueprint, code: string) => lintBlueprint(bp).filter((i) => i.code === code);

/** Each case mutates a fresh mini blueprint so that exactly one rule fails. */
const FAIL_CASES: [string, string, (bp: Blueprint) => void][] = [
  // L1
  ["L1 stage id reused by a disclosure", "L1", (bp) => { bp.playbook.stages[1]!.id = "deposit_terms"; }],
  ["L1 stage id reused by a connector", "L1", (bp) => { bp.playbook.stages[0]!.id = "deposit_link"; }],
  ["L1 tool name clashes with a built-in", "L1", (bp) => { const c = bp.connectors[2]!; if (c.type === "http_action") { c.toolName = "get_disclosure"; c.headers = []; } }],
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
  ["L3 unknown value in a disclosure", "L3", (bp) => { bp.playbook.disclosures[0]!.criticalTokens = ["{v.nope}", "24 hours"]; }],
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
  ["G1 field in next.confirm", "G1", (bp) => { bp.playbook.greeting.next.confirm = "Can you confirm {phrase.confirm} for {f.appointment_date}?"; }],
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
    bp.playbook.stages.splice(2, 1);   // no act stage, so C2 does not ask for a consent disclosure
    const c = bp.connectors[0]!; if (c.type === "payment_link") c.requiresDisclosure = null;
  }],
  ["S1 duplicate tool", "S1", (bp) => { bp.playbook.stages[0]!.tools.push("update_case_field"); }],
  // X3 (lintBlueprint re-checks even an object that skipped BlueprintSchema)
  ["X3 nested quantifier in a QA pattern", "X3", (bp) => { bp.fields[0]!.qa.ask = ["(a+)+$"]; }],
  ["X3 lookahead in an enum synonym", "X3", (bp) => { bp.fields[3]!.enumValues![0]!.synonyms = ["(?=new)new"]; }],
  ["X3 backreference in a rep-line pattern", "X3", (bp) => { bp.handoff.repLinePatterns = ["(hand) you\\1"]; }],
  ["X3 unsafe tool pattern", "X3", (bp) => { const c = bp.connectors[2]!; if (c.type === "http_action") c.params.properties.ref_code!.pattern = "(a|ab)*c"; }],
  // C2
  ["C2 disclosure without a question", "C2", (bp) => { bp.playbook.disclosures[0]!.text = "A deposit of {v.deposit|spoken_money} holds your appointment. It is refundable up to 24 hours before."; }],
  ["C2 no critical token in the text", "C2", (bp) => { bp.playbook.disclosures[0]!.criticalTokens = ["fifty dollars"]; }],
  ["C2 the act gate without consent", "C2", (bp) => { bp.playbook.disclosures[0]!.consent = false; }],
  ["C2 consent with no act stage after it", "C2", (bp) => { bp.playbook.stages.splice(2, 1); }],
  // S2
  ["S2 exit on a connector the stage does not list", "S2", (bp) => { bp.playbook.stages[2]!.tools = ["send_deposit_link", "update_case_field", "hand_back_to_rep"]; bp.playbook.stages[2]!.exit = { kind: "connector_succeeded", connector: "booking_confirmation" }; }],
  ["S2 act stage without an acting connector", "S2", (bp) => {
    bp.playbook.stages[2]!.tools = ["send_confirmation", "update_case_field", "hand_back_to_rep"];
    bp.playbook.stages[2]!.exit = { kind: "connector_succeeded", connector: "booking_confirmation" };
  }],
  ["S2 confirmation requires itself", "S2", (bp) => { const c = bp.connectors[1]!; if (c.type === "confirmation") c.requires = ["booking_confirmation"]; }],
  ["S2 exit waits on a completion webhook", "S2", (bp) => {
    bp.connectors.push({ type: "completion_webhook", id: "done_hook", label: "Done hook", url: "https://example.com/hook", hmacSecret: { $secret: "sec_0123456789abcdef" }, include: ["case"] });
    bp.playbook.stages[3]!.exit = { kind: "connector_succeeded", connector: "done_hook" };
  }],
  // S3
  ["S3 side-effect HTTP in a confirm stage", "S3", (bp) => {
    const c = bp.connectors[2]!;
    if (c.type === "http_action") { c.sideEffect = true; c.headers = []; }
    bp.playbook.stages[0]!.tools.push("log_crm_note");
  }],
  // F1
  ["F1 no required fields", "F1", (bp) => { for (const f of bp.fields) f.required = false; }],
  ["F1 an advice field the AI may set", "F1", (bp) => { bp.fields[3]!.adviceDomain = true; }],
  ["F1 a rep-only field with a confirm tool", "F1", (bp) => { bp.fields[1]!.setBy = "rep_only"; }],
  ["F1 serverResolvable names a non-money value", "F1", (bp) => {
    bp.values.push({ id: "clinic_line", label: "Clinic line", type: "text", ref: { kind: "fact", key: "clinic_phone" } });
    bp.fields[2]!.serverResolvable = { value: "clinic_line" };
  }],
  // F2
  ["F2 a required AI field without an ask phrase", "F2", (bp) => { bp.fields[0]!.phrases.ask = "  "; }],
  // X1
  ["X1 compiled prompt over 6000 characters", "X1", (bp) => {
    bp.playbook.persona.extraRules = Array.from({ length: 10 }, (_, i) => `Rule ${i + 1}: keep every answer short, plain and kind. `.repeat(5).slice(0, 290));
    bp.playbook.stages[1]!.goal = "Read the deposit terms verbatim and wait for a clear answer. ".repeat(38);
  }],
  ["X1 case JSON cap over 2400", "X1", (bp) => { bp.playbook.caseJson.maxChars = 3000; }],
  // X2
  ["X2 over 100 merged keyterms", "X2", (bp) => { bp.listening.keyterms = Array.from({ length: 100 }, (_, i) => `term ${i + 1}`); }],
  ["X2 a keyterm over 50 characters", "X2", (bp) => { bp.listening.keyterms.push("an extremely long keyterm that no STT session would ever accept"); }],
  ["X2 scenario prompt over 1750 characters", "X2", (bp) => { bp.listening.scenarioPrompt = "A dental front desk call. ".repeat(80); }],
  // G2
  ["G2 opening over 14 words", "G2", (bp) => { bp.playbook.greeting.opening = "Hi {customer.firstName}, I'm {org.name}'s AI assistant, not a person, and yes, this call is recorded."; }],
  ["G2 greeting over maxWords after drops", "G2", (bp) => { bp.playbook.greeting.maxWords = 20; }],
  ["G2 next.ask without {phrase.ask}", "G2", (bp) => { bp.playbook.greeting.next.ask = "To finish up, I just need one more thing."; }],
  // B1
  ["B1 real brand as a sample's business name", "B1", (bp) => { bp.context.samples[0]!.org.name = "Aspen Dental"; }],
  ["B1 real brand in the greeting opening", "B1", (bp) => {
    bp.playbook.greeting.opening = "Hi {customer.firstName}, I'm Delta Dental's AI assistant, not a person. This call is recorded.";
  }],
  ["B1 real brand in a disclosure", "B1", (bp) => { bp.playbook.disclosures[0]!.text = "Wells Fargo holds a deposit of {v.deposit|spoken_money}. Is that OK?"; }],
  ["B1 brand split across a section", "B1", (bp) => { bp.playbook.disclosures[0]!.text = "Wells{?opt.tax_suffix}{/?} Fargo holds {v.deposit|spoken_money}. Is that OK?"; }],
  ["B1 real brand in persona.extraRules", "B1", (bp) => { bp.playbook.persona.extraRules = ["Say you work for Chase."]; }],
  ["B1 real brand in meta.title", "B1", (bp) => { bp.meta.title = "Verizon plan change"; }],
  ["B1 real brand in an SMS template", "B1", (bp) => { const c = bp.connectors[1]!; if (c.type === "confirmation") c.smsTemplate = "PayPal: you're booked, {customer.firstName}."; }],
  // K2
  ["K2 used http_action header secret unset", "K2", (bp) => { bp.playbook.stages[0]!.tools.push("log_crm_note"); }],
  ["K2 completion webhook without a signing secret", "K2", (bp) => {
    bp.connectors.push({ type: "completion_webhook", id: "done_hook", label: "Done hook", url: "https://example.com/hook", hmacSecret: null, include: ["case"] });
  }],
];

/** Warning fixtures: exactly one rule warns, and nothing is an error. */
const WARN_CASES: [string, string, (bp: Blueprint) => void][] = [
  ["W3 the first fact after word 24", "W3", (bp) => {
    bp.playbook.greeting.summary = "{?f.treatment.verified}We are nearly done with the booking, and it is for {f.treatment.display}.{/?}";
    bp.playbook.greeting.optOut = "Say Sam anytime.";
  }],
  ["W2 a disclosure over 60 words", "W2", (bp) => {
    bp.playbook.disclosures[0]!.text = `${"Please listen carefully to these deposit terms before you decide anything today. ".repeat(5)}A deposit of {v.deposit|spoken_money} holds your appointment. Is that OK?`;
  }],
  ["W2 an id_code field without examples", "W2", (bp) => {
    bp.fields.push({ ...structuredClone(bp.fields[3]!), id: "member_id", label: "Member ID", type: "id_code", normalizer: "id_code", enumValues: undefined, examples: [], required: false });
  }],
];

describe("lint rules: one fail fixture each, the mini fixture passes", () => {
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

  it.each(WARN_CASES)("%s (warning)", (_name, code, mutate) => {
    const bp = miniBlueprint();
    mutate(bp);
    const got = lintBlueprint(bp);
    expect(got.map((i) => [i.code, i.severity])).toEqual([[code, "warn"]]);
    expect(hasLintErrors(got)).toBe(false);
  });

  it("every PLATFORM §3.4 code has at least one fail fixture here", () => {
    const covered = new Set([...FAIL_CASES, ...WARN_CASES].map(([, c]) => c));
    for (const c of LINT_CODES.filter((x) => x !== "SCHEMA" && x !== "K1")) expect(covered.has(c), c).toBe(true);
    expect(LINT_RULES_PENDING).toEqual([]);
    expect(FAIL_CASES.length + WARN_CASES.length).toBeGreaterThanOrEqual(30);
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

describe("B1, K1, K2 details", () => {
  const SECRET = { $secret: "sec_0123456789abcdef" };
  const withSecrets = () => {
    const bp = miniBlueprint();
    bp.playbook.stages[0]!.tools.push("log_crm_note");
    const c = bp.connectors[2]!;
    if (c.type === "http_action") { c.headers = [{ name: "Authorization", value: SECRET }]; c.hmacSecret = { $secret: "sec_fedcba9876543210" }; }
    bp.connectors.push({ type: "completion_webhook", id: "done_hook", label: "Done hook", url: "https://example.com/hook", hmacSecret: SECRET, include: ["case", "qa"] });
    return bp;
  };

  it("B1 ignores field phrases, stage goals and sample data (a port-in may name the carrier being left)", () => {
    const bp = miniBlueprint();
    bp.fields[0]!.phrases.ask = "the name on your Verizon account";
    bp.playbook.stages[0]!.goal = "Confirm the booking details with {subject}; they moved from Aspen Dental.";
    bp.context.facts.push({ key: "previous_dentist", label: "Previous dentist" });
    bp.context.samples[0]!.facts.previous_dentist = "Aspen Dental";
    expect(codes(bp)).toEqual([]);
  });

  it("B1 names the brand and its list, once per text", () => {
    const bp = miniBlueprint();
    bp.playbook.persona.extraRules = ["Never mention Chase or Chase Bank or Chase."];
    const got = issues(bp, "B1");
    expect(got).toHaveLength(2);
    expect(got[0]!.message).toContain("top-50 US bank");
    expect(got[0]!.path).toEqual(["playbook", "persona", "extraRules", 0]);
  });

  it("B1 checks an unparsable template on its literal text", () => {
    const bp = miniBlueprint();
    bp.playbook.greeting.optOut = "Say Sam anytime {oops. GEICO";
    expect(new Set(codes(bp))).toEqual(new Set(["L3", "B1"]));
  });

  it("K1: no secret refs in a gallery relay or a pinned publication; private relays may hold them", () => {
    const bp = withSecrets();
    expect(lintBlueprint(bp)).toEqual([]);
    expect(lintBlueprint(bp, { visibility: "private" })).toEqual([]);
    const gallery = lintBlueprint(bp, { visibility: "gallery" });
    expect(gallery.map((i) => i.code)).toEqual(["K1", "K1", "K1"]);
    expect(gallery.map((i) => i.path)).toEqual([
      ["connectors", 2, "headers", 0, "value"], ["connectors", 2, "hmacSecret"], ["connectors", 3, "hmacSecret"],
    ]);
    expect(lintBlueprint(bp, { pinnedPublication: true }).map((i) => i.code)).toEqual(["K1", "K1", "K1"]);
    expect(gallery[0]!.message).toContain("gallery");
  });

  it("K1 counts refs in unused connectors too (they would ship with the gallery JSON)", () => {
    const bp = miniBlueprint();
    const c = bp.connectors[2]!;
    if (c.type === "http_action") c.headers = [{ name: "Authorization", value: SECRET }];
    expect(lintBlueprint(bp, { visibility: "gallery" }).map((i) => i.code)).toEqual(["K1"]);
  });

  it("K2: a ref to a missing or expired secret fails when the server passes the workspace's secret ids", () => {
    const bp = withSecrets();
    expect(lintBlueprint(bp, { secretIds: ["sec_0123456789abcdef", "sec_fedcba9876543210"] })).toEqual([]);
    const got = lintBlueprint(bp, { secretIds: new Set(["sec_0123456789abcdef"]) });
    expect(got.map((i) => [i.code, i.path])).toEqual([["K2", ["connectors", 2, "hmacSecret"]]]);
    expect(got[0]!.message).toContain("missing or expired");
    expect(lintBlueprint(bp, { secretIds: [] }).map((i) => i.code)).toEqual(["K2", "K2", "K2"]);
  });

  it("K2: an unused connector's null secret and an http_action without HMAC are fine", () => {
    const bp = miniBlueprint();   // crm_note has a null Authorization header but no stage lists log_crm_note
    expect(codes(bp)).toEqual([]);
    bp.playbook.stages[0]!.tools.push("log_crm_note");
    const c = bp.connectors[2]!;
    if (c.type === "http_action") c.headers = [];
    expect(codes(bp)).toEqual([]);
  });

  it("K2 message asks for a signing secret on a cloned completion webhook", () => {
    const bp = withSecrets();
    const hook = bp.connectors[3]!;
    if (hook.type === "completion_webhook") hook.hmacSecret = null;
    expect(issues(bp, "K2")[0]!.message).toContain("Set a signing secret");
  });

  it("lintBlueprintJson passes the options through", () => {
    const json = JSON.parse(JSON.stringify(withSecrets())) as unknown;
    expect(lintBlueprintJson(json, { visibility: "gallery" }).issues.map((i) => i.code)).toEqual(["K1", "K1", "K1"]);
  });
});

describe("compiled rules (G2, W3, X1, X2, W2) and the canned snapshots", () => {
  const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
  const baton = (): Blueprint => BlueprintSchema.parse(JSON.parse(readFileSync(join(ROOT, "data", "relays", "baton-add-driver.json"), "utf8")));

  it("canned snapshots: all verified, one pending, one missing, nothing", () => {
    const bp = miniBlueprint();
    const a = bp.context.samples[0]!;
    const status = (st: (typeof CANNED_STATES)[number]) =>
      Object.fromEntries(Object.entries((cannedSnapshot(bp, st, a) as { fields: Record<string, { status: string }> }).fields).map(([k, v]) => [k, v.status]));
    expect(cannedFocusField(bp)).toBe("patient_name");
    expect(status("all_verified")).toEqual({ patient_name: "VERIFIED", appointment_date: "VERIFIED", treatment: "VERIFIED", visit_kind: "MISSING" });
    expect(status("one_pending")).toEqual({ patient_name: "PENDING", appointment_date: "VERIFIED", treatment: "VERIFIED", visit_kind: "MISSING" });
    expect(status("one_missing")).toEqual({ patient_name: "MISSING", appointment_date: "VERIFIED", treatment: "VERIFIED", visit_kind: "MISSING" });
    expect(new Set(Object.values(status("nothing")))).toEqual(new Set(["MISSING"]));
    const all = cannedSnapshot(bp, "all_verified", a) as { fields: Record<string, { value: string | null; source: string | null }> };
    expect(all.fields.treatment).toMatchObject({ value: "cleaning", source: "rep" });   // the first example, "Cleaning"
  });

  it("canned values normalize the examples against the sample (Baton: 'the Civic' → the vehicle id)", () => {
    const bp = baton();
    const a = bp.context.samples[0]!;
    const all = cannedSnapshot(bp, "all_verified", a) as { fields: Record<string, { status: string; value: string | null; source: string | null }> };
    expect(all.fields.vehicle_assignment).toMatchObject({ status: "VERIFIED", value: a.tables.vehicles![0]!.id });
    expect(all.fields.premium_new_monthly_usd).toMatchObject({ status: "VERIFIED", value: "142.00", source: "rep" });
    expect(all.fields.driver_full_name!.value).toBe("maya raman");
  });

  it("Baton: every sample × canned greeting is ≤ 40 words and states its first fact at word 17", () => {
    const bp = baton();
    const k = compileRelay(bp);
    for (const a of bp.context.samples) {
      for (const st of CANNED_STATES) {
        const snap = cannedSnapshot(bp, st, a, k.spec);
        const g = k.greeting(snap, a);
        expect(g.wordCount, `${st}: ${g.text}`).toBeLessThanOrEqual(40);
        if (st === "all_verified") expect(greetingFirstFactWord(bp, snap, a, g.dropped)).toBe(16);
        if (st === "nothing") expect(greetingFirstFactWord(bp, snap, a, g.dropped)).toBeNull();
      }
    }
    expect(lintBlueprint(bp)).toEqual([]);
    expect(lintBlueprint(bp, { flagship: true, visibility: "gallery", pinnedPublication: true, secretIds: [], simSampleRateHz: 8000 })).toEqual([]);
  });

  it("cannedCaseState: a full CaseState per canned state that takes over at every stage (WP14b's binding)", () => {
    for (const bp of [miniBlueprint(), baton()]) {
      const k = compileRelay(bp);
      const a = bp.context.samples[0]!;
      for (const st of CANNED_STATES) {
        const cs = cannedCaseState(k, a, st);
        expect(cs.caseId).toBe(`case_canned_${st}`);
        expect(cs.readiness.requiredTotal).toBe(bp.fields.filter((f) => f.required).length);
        expect(cs.readiness.ready).toBe(st === "all_verified");
        for (const s of bp.playbook.stages) {
          const stage = ({ confirm: "confirm", disclose: "disclose", act: "pay", close: "close" } as const)[s.kind];
          expect(() => k.takeover(cs, a, { deployId: "canned", stage, keytermsEnabled: true }), `${bp.meta.slug}/${st}/${stage}`).not.toThrow();
        }
      }
    }
    expect(() => cannedCaseState({ ...compileRelay(miniBlueprint()), blueprint: null }, miniBlueprint().context.samples[0]!, "nothing")).toThrow(/kernel-compiled/);
  });

  it("W2 warns on a wideband_16k preset over 8 kHz sims only when the sim rate is known", () => {
    const bp = miniBlueprint();
    bp.listening.tuning = "wideband_16k";
    expect(lintBlueprint(bp)).toEqual([]);
    expect(lintBlueprint(bp, { simSampleRateHz: 16_000 })).toEqual([]);
    expect(lintBlueprint(bp, { simSampleRateHz: 8_000 }).map((i) => [i.code, i.severity, i.path])).toEqual([["W2", "warn", ["listening", "tuning"]]]);
  });

  it("the compiled rules wait for the structural ones", () => {
    const bp = miniBlueprint();
    bp.playbook.greeting.maxWords = 20;                          // G2 on its own …
    bp.playbook.greeting.optOut = "Call {fact.nope} anytime.";   // … but an L3 error blocks the compiled rules
    expect(codes(bp)).toEqual(["L3"]);
  });

  it("G2 reports the worst render once, with its word count and state", () => {
    const bp = miniBlueprint();
    bp.playbook.greeting.maxWords = 20;
    const [g2] = issues(bp, "G2");
    expect(g2!.path).toEqual(["playbook", "greeting"]);
    expect(g2!.message).toMatch(/is \d+ words \(sample #1, .*; \d of 4 canned renders over\)/);
  });

  it("X1 measures the prompt with the safety block unless the relay is the flagship", () => {
    const bp = miniBlueprint();
    bp.playbook.persona.extraRules = Array.from({ length: 10 }, (_, i) => `Rule ${i + 1}: keep every answer short, plain and kind. `.repeat(5).slice(0, 290));
    bp.playbook.stages[1]!.goal = "Read the deposit terms verbatim and wait for a clear answer. ".repeat(38);
    expect(issues(bp, "X1")[0]!.message).toMatch(/compiled prompt is \d+ characters at stage "disclose_deposit"/);
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
