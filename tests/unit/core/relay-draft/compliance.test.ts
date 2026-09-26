/**
 * The drafting post-fixes (PLATFORM §7.4 step 5; WP17·3). These four are not judgment calls, so they are applied
 * after the model has had its say and they are what the tests pin. Offline, $0.
 */
import { describe, expect, it } from "vitest";

import { BlueprintSchema } from "@/core/contracts/v2/blueprint";
import { containsDenylistedBrand } from "@/core/relay/brand-denylist";
import { lintBlueprint } from "@/core/relay/lint";
import { applyComplianceFixes, COMPLIANT_OPENING, SAMPLE_MARK } from "@/core/relay/draft/compliance";
import { expandDraft } from "@/core/relay/draft/expand";
import { draftFixture } from "./helpers";

const base = () => expandDraft(draftFixture(), { callDate: "2026-09-25" }).blueprint;
const errors = (bp: Parameters<typeof lintBlueprint>[0]) => lintBlueprint(bp).filter((i) => i.severity === "error");

describe("applyComplianceFixes", () => {
  it("does not mutate its input", () => {
    const bp = base();
    const before = JSON.stringify(bp);
    applyComplianceFixes(bp);
    expect(JSON.stringify(bp)).toBe(before);
  });

  it("leaves a clean relay lint-clean", () => {
    const { blueprint, applied } = applyComplianceFixes(base());
    expect(BlueprintSchema.safeParse(blueprint).success).toBe(true);
    expect(errors(blueprint)).toEqual([]);
    expect(applied.greeting).toBe(false);
    expect(applied.removedFields).toEqual([]);
  });

  it("restores the compliant opening when the greeting lost it", () => {
    const bp = base();
    bp.playbook.greeting.opening = "Hi {customer.firstName}, how can I help?";
    const { blueprint, notes, applied } = applyComplianceFixes(bp);
    expect(blueprint.playbook.greeting.opening).toBe(COMPLIANT_OPENING);
    expect(applied.greeting).toBe(true);
    expect(notes.join(" ")).toContain("not optional");
    expect(errors(blueprint)).toEqual([]);
  });

  it("caps maxWords at the 40-word budget", () => {
    const bp = base();
    (bp.playbook.greeting as { maxWords: number }).maxWords = 60;
    expect(applyComplianceFixes(bp).blueprint.playbook.greeting.maxWords).toBe(40);
  });

  it("removes any field that would collect a card, bank or ID number, however it is spelled", () => {
    const bp = base();
    const spelling = ["card_number", "cardNumber", "customer card number", "bank_routing", "ssn", "social security number", "account_number"];
    for (const [i, s] of spelling.entries()) {
      const copy = structuredClone(bp);
      copy.fields = [
        { ...copy.fields[0]!, id: `f_${i}`, label: s },
        copy.fields[0]!,
      ];
      const { blueprint, notes, applied } = applyComplianceFixes(copy);
      expect(blueprint.fields.map((f) => f.id), s).not.toContain(`f_${i}`);
      expect(applied.removedFields, s).toHaveLength(1);
      expect(notes.join(" ")).toContain("a payment link does");
    }
  });

  it("keeps neverCollect complete even if the draft trimmed it", () => {
    const bp = base();
    (bp.compliance as { neverCollect: string[] }).neverCollect = ["ssn"];
    expect(applyComplianceFixes(bp).blueprint.compliance.neverCollect).toEqual(["card_number", "bank_account", "password", "ssn"]);
  });

  it("marks every disclosure SAMPLE, exactly once", () => {
    const { blueprint, applied } = applyComplianceFixes(base());
    expect(applied.disclosures).toBe(1);
    for (const d of blueprint.playbook.disclosures) expect(d.text.startsWith(SAMPLE_MARK)).toBe(true);
    const twice = applyComplianceFixes(blueprint);
    expect(twice.applied.disclosures).toBe(0);
    expect(twice.blueprint.playbook.disclosures[0]!.text).toBe(blueprint.playbook.disclosures[0]!.text);
  });

  it("replaces a real brand everywhere it appears, with the relay's own fictional name", () => {
    const bp = base();
    bp.meta.tagline = "Now part of Aetna.";
    bp.playbook.stages[0]!.goal = "Confirm the Aetna plan with the patient.";
    const { blueprint, notes, applied } = applyComplianceFixes(bp);
    expect(applied.brands).toContain("Aetna");
    expect(blueprint.meta.tagline).toContain("Riverbend Dental");
    expect(containsDenylistedBrand(blueprint.meta.tagline)).toBe(false);
    expect(containsDenylistedBrand(blueprint.playbook.stages[0]!.goal)).toBe(false);
    expect(notes.join(" ")).toContain("Everything in a relay is fictional");
    expect(errors(blueprint)).toEqual([]);
  });

  it("falls back to a neutral name when the business name is itself a real brand", () => {
    const bp = base();
    for (const s of bp.context.samples) s.org.name = "Aetna Dental";
    const { blueprint } = applyComplianceFixes(bp);
    for (const s of blueprint.context.samples) {
      expect(containsDenylistedBrand(s.org.name, "name")).toBe(false);
      expect(s.org.name).toContain("Example Company");
    }
  });

  it("never blanks the last field: a relay of card numbers alone keeps what it has", () => {
    const bp = base();
    bp.fields = [{ ...bp.fields[0]!, id: "card_number", label: "Card number" }];
    const { blueprint } = applyComplianceFixes(bp);
    expect(blueprint.fields).toHaveLength(1);
  });
});
