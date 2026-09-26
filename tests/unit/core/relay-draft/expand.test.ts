/**
 * `expandDraft` (PLATFORM §7.4 step 3; WP17·3): the deterministic half of the wizard.
 *
 * The point of these tests is the claim the pipeline rests on - **a drafted relay is lint-clean without a repair
 * round** - and that every structural repair is real and recorded. Offline, $0.
 */
import { describe, expect, it } from "vitest";

import { lintBlueprint } from "@/core/relay/lint";
import { BlueprintSchema } from "@/core/contracts/v2/blueprint";
import { expandDraft, labelWords, qaAskPatterns, safeId, safeSlug, uniqueId } from "@/core/relay/draft/expand";
import { isSafeRegexSource } from "@/core/contracts/v2/regex";
import { draftFixture } from "./helpers";

const CALL_DATE = "2026-09-25";
const expand = (over: Parameters<typeof draftFixture>[0] = {}) => expandDraft(draftFixture(over), { callDate: CALL_DATE });
const errors = (bp: Parameters<typeof lintBlueprint>[0]) => lintBlueprint(bp).filter((i) => i.severity === "error");

describe("expandDraft: the happy path", () => {
  const { blueprint, notes } = expand();

  it("produces a blueprint that parses and lints with no errors", () => {
    expect(BlueprintSchema.safeParse(blueprint).success).toBe(true);
    expect(errors(blueprint)).toEqual([]);
  });

  it("is deterministic: the same draft expands byte for byte", () => {
    expect(JSON.stringify(expand().blueprint)).toBe(JSON.stringify(blueprint));
  });

  it("keeps the model's notes and adds nothing when nothing needed repairing", () => {
    expect(notes).toEqual(draftFixture().notes);
  });

  it("fills the mechanical half from the field type", () => {
    const name = blueprint.fields.find((f) => f.id === "patient_full_name")!;
    expect(name.normalizer).toBe("person_name");
    expect(name.display).toBe("title");
    expect(name.compare).toBe("token_subset");
    expect(name.capture).toEqual({ priority: 1, mode: "max_accuracy", entity: true });
    const date = blueprint.fields.find((f) => f.id === "appointment_date")!;
    expect(date.normalizer).toBe("date");
    expect(date.display).toBe("spoken_date");
  });

  it("writes ask/confirm phrases and QA patterns from the label", () => {
    const carrier = blueprint.fields.find((f) => f.id === "insurance_carrier")!;
    expect(carrier.phrases.ask).toBe("the insurance carrier");
    expect(carrier.phrases.confirm).toBe("the insurance carrier is {f.insurance_carrier.display}");
    expect(carrier.qa.ask).toContain("\\b(insurance\\s+carrier)\\b");
    for (const p of blueprint.fields.flatMap((f) => f.qa.ask)) expect(isSafeRegexSource(p)).toBe(true);
  });

  it("makes the summary droppable, so a long closing sentence cannot break the 40-word budget (lint G2)", () => {
    const g = blueprint.playbook.greeting;
    expect(g.summary).toBe("{clause.wrap}");
    expect(g.clauses).toEqual([{ id: "wrap", text: "I'll finish up from here.", dropOrder: 0 }]);
  });

  it("leaves the prompt generated and gives the greeting the compliant opening", () => {
    expect(blueprint.playbook.promptTemplate).toBeNull();
    expect(blueprint.playbook.greeting.opening).toContain("AI assistant");
    expect(blueprint.playbook.greeting.opening).toContain("not a person");
    expect(blueprint.playbook.greeting.opening).toContain("recorded");
    expect(blueprint.playbook.greeting.maxWords).toBe(40);
  });

  it("builds two fictional sample accounts, each with a mailing address", () => {
    expect(blueprint.context.samples).toHaveLength(2);
    for (const s of blueprint.context.samples) {
      expect(s.customer.address).toBeTruthy();
      expect(s.customer.phoneLast4).toMatch(/^\d{4}$/);
      expect(s.callDate).toBe(CALL_DATE);
    }
    expect(blueprint.context.samples[0]!.customer.firstName).toBe("Maya");
    expect(blueprint.context.samples[1]!.customer.firstName).not.toBe("Maya");
    expect(expand({ samples: undefined } as never).blueprint.context.samples).toHaveLength(2);
  });

  it("orders the stages, gives each its built-in tools and the right exit", () => {
    const stages = blueprint.playbook.stages;
    expect(stages.map((s) => s.kind)).toEqual(["confirm", "disclose", "act", "close"]);
    for (const s of stages) {
      expect(s.tools).toContain("update_case_field");
      expect(s.tools).toContain("hand_back_to_rep");
    }
    expect(stages[1]!.tools).toContain("get_disclosure");
    expect(stages[1]!.exit).toEqual({ kind: "disclosure_accepted", disclosure: "deposit_terms" });
    expect(stages[2]!.exit).toEqual({ kind: "connector_succeeded", connector: "deposit_link" });
    expect(stages[3]!.exit).toEqual({ kind: "end" });
  });

  it("sets consent on the disclosure the act stage waits on (lint C2)", () => {
    expect(blueprint.playbook.disclosures[0]!.consent).toBe(true);
    expect(blueprint.playbook.disclosures[0]!.criticalTokens[0]).toContain("non-refundable");
  });

  it("scales sessionCap to what the assistant actually has to finish", () => {
    expect(blueprint.playbook.sessionCap.maxSec).toBeGreaterThan(180);
    expect(blueprint.playbook.sessionCap.maxSec).toBeLessThanOrEqual(420);
  });
});

describe("expandDraft: the repairs", () => {
  it("never leaves an adviceDomain field ai_allowed, and says so", () => {
    const { blueprint, notes } = expand({
      fields: [
        { id: "quoted_price", label: "Quoted price", description: "What the coordinator quoted.", type: "money", required: true, setBy: "ai_allowed", adviceDomain: true, example: "120.00", enumValues: [] },
        { id: "patient_full_name", label: "Patient name", description: "The patient's name.", type: "person_name", required: true, setBy: "ai_allowed", adviceDomain: false, example: "Maya Ortiz", enumValues: [] },
      ],
    });
    expect(blueprint.fields.find((f) => f.id === "quoted_price")!.setBy).toBe("rep_only");
    expect(notes.join(" ")).toContain("never change it");
    expect(errors(blueprint)).toEqual([]);
  });

  it("leaves something for the assistant to finish when the draft left nothing", () => {
    const { blueprint, notes } = expand({
      fields: draftFixture().fields.map((f) => ({ ...f, setBy: "rep_only" as const })),
    });
    expect(blueprint.fields.some((f) => f.required && f.setBy === "ai_allowed")).toBe(true);
    expect(notes.join(" ")).toContain("has something to do");
  });

  it("merges repeated stage kinds and puts them back in order", () => {
    const { blueprint, notes } = expand({
      stages: [
        { id: "close_it", kind: "close", label: "Close", goal: "Close warmly.", useConnectors: [] },
        { id: "confirm_a", kind: "confirm", label: "Confirm", goal: "Confirm.", useConnectors: [] },
        { id: "confirm_b", kind: "confirm", label: "Again", goal: "Confirm again.", useConnectors: [] },
      ],
    });
    expect(blueprint.playbook.stages.map((s) => s.kind)).toEqual(["confirm", "disclose", "act", "close"]);
    expect(blueprint.playbook.stages.filter((s) => s.kind === "confirm")).toHaveLength(1);
    expect(notes.join(" ")).toContain("Merged repeated stages");
    expect(errors(blueprint)).toEqual([]);
  });

  it("adds a consent disclosure when a payment has nothing to read first (lint C2)", () => {
    const { blueprint, notes } = expand({ disclosures: [], stages: draftFixture().stages.filter((s) => s.kind !== "disclose") });
    expect(blueprint.playbook.disclosures).toHaveLength(1);
    expect(blueprint.playbook.disclosures[0]!.consent).toBe(true);
    expect(blueprint.playbook.stages.map((s) => s.kind)).toContain("disclose");
    expect(notes.join(" ")).toContain("consent notice");
    expect(errors(blueprint)).toEqual([]);
  });

  it("drops an act stage with nothing that acts, and the connector no stage can reach", () => {
    const { blueprint, notes } = expand({ connectors: [draftFixture().connectors[1]!], values: [] });
    expect(blueprint.playbook.stages.map((s) => s.kind)).not.toContain("act");
    expect(notes.join(" ")).toContain("Dropped the payment step");
    expect(errors(blueprint)).toEqual([]);
  });

  it("invents the money value a payment link needs, and says the amount is a sample", () => {
    const { blueprint, notes } = expand({ values: [] });
    const link = blueprint.connectors.find((c) => c.type === "payment_link")!;
    expect("amount" in link && link.amount).toBeTruthy();
    expect(blueprint.values.some((v) => v.id === ("amount" in link ? link.amount : ""))).toBe(true);
    expect(notes.join(" ")).toContain("sample $50.00");
  });

  it("makes a disclosure answerable and gives it a token that is really in the text", () => {
    const { blueprint } = expand({
      disclosures: [{ id: "terms", title: "Terms", text: "The deposit is non-refundable", criticalTokens: ["a phrase that is not there"] }],
    });
    const d = blueprint.playbook.disclosures[0]!;
    expect(d.text).toContain("?");
    expect(d.text.toLowerCase()).toContain(d.criticalTokens[0]!.toLowerCase());
    expect(errors(blueprint)).toEqual([]);
  });

  it("writes SMS templates that parse, whatever the model put in braces", () => {
    const { blueprint } = expand({
      connectors: draftFixture().connectors.map((c) => ({ ...c, smsText: "Pay here: {link} for {amount}" })),
    });
    for (const c of blueprint.connectors) {
      const t = "smsTemplate" in c ? c.smsTemplate : "";
      expect(t).not.toContain("{link}");
      expect(t).toContain("{org.name}");
    }
    expect(errors(blueprint)).toEqual([]);
  });
});

describe("the id and label helpers", () => {
  it("labelWords drops the filler", () => {
    expect(labelWords("The date of your appointment")).toEqual(["date", "appointment"]);
  });

  it("qaAskPatterns is literal, anchored and safe", () => {
    const p = qaAskPatterns("Insurance carrier");
    expect(p[0]).toBe("\\b(insurance\\s+carrier)\\b");
    expect(p[1]).toBe("\\b(carrier)\\b");
    for (const x of p) expect(isSafeRegexSource(x)).toBe(true);
    expect(qaAskPatterns("the")).toEqual([]);
  });

  it("safeSlug and safeId always return something the schema accepts", () => {
    expect(safeSlug("Riverbend Deposit!")).toBe("riverbend-deposit");
    expect(safeSlug("x")).toBe("drafted-relay");
    expect(safeId("Patient Name", "f")).toBe("patient_name");
    expect(safeId("42", "fallback")).toBe("fallback");
  });

  it("uniqueId never collides (lint L1 spans every id in a blueprint)", () => {
    const taken = new Set<string>();
    expect(uniqueId("deposit", taken)).toBe("deposit");
    expect(uniqueId("deposit", taken)).toBe("deposit_2");
    expect(uniqueId("deposit", taken)).toBe("deposit_3");
  });

  it("a field and a connector that share an id are separated", () => {
    const { blueprint } = expand({
      connectors: draftFixture().connectors.map((c, i) => (i === 0 ? { ...c, id: "patient_full_name" } : c)),
    });
    const ids = [...blueprint.fields.map((f) => f.id), ...blueprint.connectors.map((c) => c.id), ...blueprint.values.map((v) => v.id)];
    expect(new Set(ids).size).toBe(ids.length);
    expect(errors(blueprint)).toEqual([]);
  });
});
