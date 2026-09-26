/**
 * The "Add field" presets (SAAS §5.5, WP15·2) — and the drift test `client/studio/field-presets.ts` promises.
 *
 * `FIELD_TYPE_RULES` restates WP17's private `TYPE_RULES`: the normalizer, display formatter, comparison, entity
 * flag and capture mode that follow mechanically from a field's type. It has to be restated because the table is
 * not exported, and a *silent* copy is the dangerous kind — if WP17 retunes how a money field is read back, the
 * Studio would keep adding fields with the old formatter and nobody would find out until a call said "fifty
 * point zero zero".
 *
 * So the first test here runs the real `expandDraft` over one field of every draft type and compares the five
 * keys one by one. If WP17 changes its table, **this test fails** rather than the product drifting.
 *
 * Offline, $0.
 */
import { describe, expect, it } from "vitest";

import {
  FIELD_PRESETS, FIELD_TYPE_OPTIONS, FIELD_TYPE_RULES, NEW_ENUM_VALUES, newFieldFromPreset, typeChangeEdits,
} from "@/client/studio/field-presets";
import { FieldSchema, FIELD_TYPES } from "@/core/contracts/v2/blueprint";
import { DRAFT_FIELD_TYPES } from "@/core/relay/draft/schema";
import { expandDraft } from "@/core/relay/draft/expand";

import { draftFixture } from "../core/relay-draft/helpers";
import { applyAndParse, commentedDental, parse } from "./helpers";

const CALL_DATE = "2026-09-26";

/**
 * One field per draft type, so `expandDraft` fills in the mechanical half for every row of the table.
 *
 * In two batches: there are thirteen draft types and `expandDraft` keeps `DRAFT_MAX_FIELDS` (12) of them, so a
 * single draft would silently drop the last type — and a drift test that skips a row is worse than none.
 */
function expandedByType() {
  const draftField = (type: (typeof DRAFT_FIELD_TYPES)[number], i: number) => ({
    id: `f_${type}`,
    label: `Field ${i + 1}`,
    description: `The ${type}.`,
    type,
    required: true,
    setBy: "rep_or_customer" as const,
    adviceDomain: false,
    example: null,
    enumValues: type === "enum" ? [{ value: "one", label: "one" }, { value: "two", label: "two" }] : [],
  });
  const half = Math.ceil(DRAFT_FIELD_TYPES.length / 2);
  const out = new Map<string, ReturnType<typeof expandDraft>["blueprint"]["fields"][number]>();
  for (const batch of [DRAFT_FIELD_TYPES.slice(0, half), DRAFT_FIELD_TYPES.slice(half)]) {
    const { blueprint } = expandDraft(draftFixture({ fields: batch.map(draftField) }), { callDate: CALL_DATE });
    for (const f of blueprint.fields) out.set(f.type, f);
  }
  return out;
}

describe("the drift test against WP17's expandDraft", () => {
  const expanded = expandedByType();

  it.each([...DRAFT_FIELD_TYPES])("agrees with expandDraft on every mechanical key for %s", (type) => {
    const field = expanded.get(type);
    expect(field, `expandDraft produced no ${type} field`).toBeDefined();
    const rule = FIELD_TYPE_RULES[type];
    expect(rule.normalizer).toBe(field!.normalizer);
    expect(rule.display).toBe(field!.display);
    expect(rule.compare).toBe(field!.compare);
    expect(rule.entity).toBe(field!.capture.entity);
    expect(rule.mode).toBe(field!.capture.mode);
  });

  it("has a rule for every type in the contract, including the two the wizard never drafts", () => {
    expect(Object.keys(FIELD_TYPE_RULES).sort()).toEqual([...FIELD_TYPES].sort());
    for (const extra of ["signed_money", "lookup"] as const) {
      expect(DRAFT_FIELD_TYPES).not.toContain(extra);
      expect(FIELD_TYPE_RULES[extra]).toBeDefined();
    }
  });

  it("offers a preset for every type the wizard knows, in the menu order", () => {
    expect([...FIELD_PRESETS].map((p) => p.type).sort()).toEqual([...DRAFT_FIELD_TYPES].sort());
    for (const p of FIELD_PRESETS) expect(p.hint.length).toBeGreaterThan(0);
    expect(FIELD_TYPE_OPTIONS).toEqual(FIELD_TYPES);
  });
});

describe("newFieldFromPreset", () => {
  it("produces a field that passes FieldSchema for every preset", () => {
    for (const p of FIELD_PRESETS) {
      const field = newFieldFromPreset({ type: p.type, label: p.label, taken: [], index: 0 });
      const result = FieldSchema.safeParse(field);
      expect(result.success, `${p.type}: ${JSON.stringify(result.error?.issues)}`).toBe(true);
    }
  });

  it("matches expandDraft's own defaults for the four keys a builder then changes", () => {
    const field = newFieldFromPreset({ type: "text", label: "Insurance carrier", taken: [], index: 3 });
    expect(field.required).toBe(true);
    expect(field.setBy).toBe("ai_allowed");
    expect(field.adviceDomain).toBe(false);
    expect(field.promptVisibility).toBe("always");
    expect(field.capture.priority).toBe(4);
    expect(field.phrases.ask).toBe("the insurance carrier");
    expect(field.phrases.confirm).toBe("the insurance carrier is {f.insurance_carrier.display}");
    expect(field.qa.ask.length).toBeGreaterThan(0);
  });

  it("derives a legal id from the label and avoids the ones already taken", () => {
    expect(newFieldFromPreset({ type: "text", label: "Policy number", taken: [], index: 0 }).id).toBe("policy_number");
    expect(newFieldFromPreset({ type: "text", label: "Policy number", taken: ["policy_number"], index: 0 }).id).toBe("policy_number_2");
    // A label with nothing usable in it still has to produce a schema-legal id.
    const odd = newFieldFromPreset({ type: "text", label: "***", taken: [], index: 6 });
    expect(odd.id).toMatch(/^[a-z][a-z0-9_]{1,39}$/);
  });

  it("trims and caps an over-long label rather than failing zod on it", () => {
    const field = newFieldFromPreset({ type: "text", label: `  a   b  ${"x".repeat(200)}`, taken: [], index: 0 });
    expect(field.label.length).toBeLessThanOrEqual(60);
    expect(field.label.startsWith("a b ")).toBe(true);
    expect(FieldSchema.safeParse(field).success).toBe(true);
  });

  it("gives a choice field two editable options, not an empty list", () => {
    const field = newFieldFromPreset({ type: "enum", label: "Procedure", taken: [], index: 0 });
    expect(field.enumValues).toHaveLength(2);
    // A fresh copy each time: two new fields must not share one array.
    const other = newFieldFromPreset({ type: "enum", label: "Plan", taken: [], index: 1 });
    expect(other.enumValues).not.toBe(field.enumValues);
    expect(other.enumValues?.[0]).not.toBe(NEW_ENUM_VALUES[0]);
  });

  it("gives no enumValues to a non-enum field", () => {
    expect(newFieldFromPreset({ type: "text", label: "Note", taken: [], index: 0 }).enumValues).toBeUndefined();
  });

  it("appends into the real document and still validates", () => {
    const bp = parse(commentedDental());
    const field = newFieldFromPreset({ type: "date", label: "Follow-up date", taken: bp.fields.map((f) => f.id), index: bp.fields.length });
    const { blueprint, text } = applyAndParse(commentedDental(), [{ path: ["fields", bp.fields.length], value: field }]);
    expect(blueprint.fields.at(-1)!.id).toBe(field.id);
    expect(text).toContain("# --- the case fields ---");
  });
});

describe("typeChangeEdits", () => {
  const bp = parse(commentedDental());
  const field = bp.fields[0]!;

  it("moves the whole mechanical half with the type, not just the type", () => {
    const edits = typeChangeEdits(0, "money", field);
    const keys = edits.map((e) => e.path.slice(2).join("."));
    expect(keys).toEqual(expect.arrayContaining(["type", "normalizer", "display", "compare", "capture.mode", "capture.entity"]));
    const byKey = new Map(edits.map((e) => [e.path.slice(2).join("."), e.value]));
    expect(byKey.get("normalizer")).toBe(FIELD_TYPE_RULES.money.normalizer);
    expect(byKey.get("display")).toBe(FIELD_TYPE_RULES.money.display);
  });

  it("leaves the label, the phrases and the QA patterns alone: they are the author's", () => {
    const touched = typeChangeEdits(0, "money", field).map((e) => String(e.path[2]));
    for (const own of ["label", "description", "phrases", "qa", "required", "setBy"]) expect(touched).not.toContain(own);
  });

  it("brings enumValues in with the enum type and takes them out again", () => {
    const toEnum = typeChangeEdits(0, "enum", field);
    const added = toEnum.find((e) => e.path[2] === "enumValues");
    expect(added?.value).toHaveLength(2);

    const enumField = { ...field, type: "enum" as const, enumValues: NEW_ENUM_VALUES.map((v) => ({ ...v })) };
    const away = typeChangeEdits(0, "text", enumField);
    expect(away.find((e) => e.path[2] === "enumValues")?.value).toBeUndefined();
    expect(away.some((e) => e.path[2] === "enumValues")).toBe(true);
  });

  it("does not overwrite choices the builder already wrote", () => {
    const enumField = {
      ...field,
      type: "enum" as const,
      enumValues: [{ value: "mine", label: "Mine", synonyms: [], spokenForms: ["mine"] }],
    };
    expect(typeChangeEdits(0, "enum", enumField).some((e) => e.path[2] === "enumValues")).toBe(false);
  });

  it("applies to the document and leaves a field that still validates", () => {
    const { blueprint } = applyAndParse(commentedDental(), typeChangeEdits(0, "money", field));
    const changed = blueprint.fields[0]!;
    expect(changed.type).toBe("money");
    expect(changed.normalizer).toBe(FIELD_TYPE_RULES.money.normalizer);
    expect(changed.display).toBe(FIELD_TYPE_RULES.money.display);
    expect(changed.capture.mode).toBe(FIELD_TYPE_RULES.money.mode);
    expect(changed.enumValues).toBeUndefined();
    expect(FieldSchema.safeParse(changed).success).toBe(true);
  });
});
