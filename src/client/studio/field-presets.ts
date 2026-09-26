"use client";
/**
 * client/studio/field-presets.ts - the "Add field" presets of the Configure tab (SAAS §5.5, WP15·2).
 *
 * A `BlueprintField` has twenty keys and only four of them are a judgement call: the label, the type, whether it is
 * required and who may set it. The other sixteen follow mechanically from the type, and **WP17's `expandDraft`
 * already decides them** — the normalizer, the display formatter, how values compare, whether STT treats the field
 * as an entity and which transcription mode captures it, plus the ask/confirm phrases and the QA patterns built
 * from the label.
 *
 * So this module is deliberately a *mirror* of `core/relay/draft/expand.ts`, not a second opinion:
 *  - `qaAskPatterns`, `safeId` and `uniqueId` are imported from it, so the parts with real logic exist once;
 *  - `FIELD_TYPE_RULES` restates its private `TYPE_RULES` table, which cannot be imported, and
 *    `tests/unit/studio/field-presets.test.ts` runs `expandDraft` over every draft type and asserts the two agree
 *    key by key. If WP17 retunes a type, that test fails here rather than the Studio quietly drifting.
 *
 * The two types `expandDraft` never emits (`signed_money`, `lookup`) are marked below: the wizard has no reason to
 * produce them, but a builder can still switch an existing field to one in the type dropdown, and a field with no
 * rule at all would keep the previous type's normalizer.
 */
import "client-only";

import { FIELD_TYPES, type BlueprintField } from "@/core/contracts/v2/blueprint";
import { qaAskPatterns, safeId, uniqueId } from "@/core/relay/draft/expand";

export type FieldType = BlueprintField["type"];

export interface FieldTypeRule {
  normalizer: BlueprintField["normalizer"];
  display: BlueprintField["display"];
  compare: BlueprintField["compare"];
  /** STT entity detection. */
  entity: boolean;
  mode: BlueprintField["capture"]["mode"];
}

/**
 * One row per `FIELD_TYPES` entry. The first thirteen are `expandDraft`'s `TYPE_RULES` verbatim (the drift test
 * proves it); the last two are ours, because the wizard never drafts them.
 */
export const FIELD_TYPE_RULES: Readonly<Record<FieldType, FieldTypeRule>> = Object.freeze({
  text: { normalizer: "text", display: "raw", compare: "token_subset", entity: false, mode: "balanced" },
  person_name: { normalizer: "person_name", display: "title", compare: "token_subset", entity: true, mode: "max_accuracy" },
  date: { normalizer: "date", display: "spoken_date", compare: "exact", entity: true, mode: "balanced" },
  number: { normalizer: "number", display: "raw", compare: "exact", entity: false, mode: "balanced" },
  integer: { normalizer: "integer", display: "raw", compare: "exact", entity: false, mode: "balanced" },
  money: { normalizer: "money", display: "spoken_money", compare: "exact", entity: false, mode: "max_accuracy" },
  enum: { normalizer: "enum", display: "enum_label", compare: "exact", entity: false, mode: "balanced" },
  phone: { normalizer: "us_phone", display: "spoken_chars", compare: "exact", entity: true, mode: "max_accuracy" },
  zip: { normalizer: "us_zip5", display: "spoken_zip", compare: "exact", entity: true, mode: "max_accuracy" },
  state: { normalizer: "us_state", display: "state_name", compare: "exact", entity: false, mode: "balanced" },
  boolean: { normalizer: "boolean", display: "raw", compare: "exact", entity: false, mode: "balanced" },
  email: { normalizer: "email", display: "lower", compare: "exact", entity: true, mode: "max_accuracy" },
  id_code: { normalizer: "id_code", display: "spoken_chars", compare: "exact", entity: true, mode: "max_accuracy" },
  // Not in `expandDraft`: reachable only by changing an existing field's type in the Configure form.
  signed_money: { normalizer: "signed_money", display: "spoken_money", compare: "exact", entity: false, mode: "max_accuracy" },
  lookup: { normalizer: "lookup", display: "lookup_label", compare: "exact", entity: false, mode: "balanced" },
});

/** The "Add field" menu, in the order it is offered. Every entry is a type `expandDraft` knows. */
export interface FieldPreset {
  type: FieldType;
  /** The menu entry, and the starting label of the field it adds. */
  label: string;
  /** One line under the menu entry. */
  hint: string;
}

export const FIELD_PRESETS: readonly FieldPreset[] = Object.freeze([
  { type: "text", label: "Text", hint: "Anything short and free-form." },
  { type: "person_name", label: "Person name", hint: "Captured as an entity, compared word by word." },
  { type: "date", label: "Date", hint: "Spoken back as a date." },
  { type: "money", label: "Amount", hint: "Spoken back as money." },
  { type: "integer", label: "Whole number", hint: "A count, with no decimals." },
  { type: "number", label: "Number", hint: "Any number." },
  { type: "enum", label: "Choice", hint: "One of a fixed list you write." },
  { type: "boolean", label: "Yes or no", hint: "A yes/no answer." },
  { type: "phone", label: "Phone number", hint: "Read back digit by digit." },
  { type: "email", label: "Email address", hint: "Lower-cased when it is read back." },
  { type: "id_code", label: "ID or reference", hint: "A member id, claim number or reference, read back character by character." },
  { type: "zip", label: "ZIP code", hint: "Five digits, read back digit by digit." },
  { type: "state", label: "State", hint: "A US state, spoken by name." },
] as const);

/** Two starting options so a new choice field is editable rather than empty (lint asks for at least one). */
export const NEW_ENUM_VALUES: NonNullable<BlueprintField["enumValues"]> = [
  { value: "option_one", label: "Option one", synonyms: [], spokenForms: ["option one"] },
  { value: "option_two", label: "Option two", synonyms: [], spokenForms: ["option two"] },
];

export interface NewFieldInput {
  type: FieldType;
  label: string;
  /** Every id already used anywhere in the blueprint (lint L1 spans all of them). */
  taken: Iterable<string>;
  /** Where the field will sit in `fields`; it becomes `capture.priority`, exactly as in `expandDraft`. */
  index: number;
}

/**
 * A whole, schema-valid `BlueprintField` from a type and a label — the "Add field" presets of SAAS §5.5.
 *
 * The defaults are `expandDraft`'s: required, `ai_allowed` (so the assistant may actually collect it), not an advice
 * domain, always visible in the prompt, no validation and no examples. A builder changes those four in the table;
 * everything else is already right for the type.
 */
export function newFieldFromPreset(i: NewFieldInput): BlueprintField {
  const rule = FIELD_TYPE_RULES[i.type] ?? FIELD_TYPE_RULES.text;
  const label = i.label.replace(/\s+/g, " ").trim().slice(0, 60) || "New field";
  const lower = label.toLowerCase();
  const taken = new Set(i.taken);
  const id = uniqueId(safeId(label, `field_${i.index + 1}`), taken);
  return {
    id,
    label,
    description: `The ${lower}.`,
    type: i.type,
    normalizer: rule.normalizer,
    ...(i.type === "enum" ? { enumValues: NEW_ENUM_VALUES.map((v) => ({ ...v })) } : {}),
    required: true,
    setBy: "ai_allowed",
    adviceDomain: false,
    promptVisibility: "always",
    validation: {},
    examples: [],
    compare: rule.compare,
    display: rule.display,
    capture: { priority: i.index + 1, mode: rule.mode, entity: rule.entity },
    phrases: { ask: `the ${lower}`, confirm: `the ${lower} is {f.${id}.display}` },
    qa: { ask: qaAskPatterns(label), weak: [] },
    ui: { group: null, hidden: false },
  };
}

/**
 * The edits that re-apply a type's mechanical half after the type dropdown changes.
 *
 * Changing `type` alone leaves the previous type's normalizer and formatter behind — a date turned into money would
 * still be normalized as a date and read back as "the sixth of October". These five keys move with it; the label,
 * the phrases and the QA patterns are the author's and are left alone.
 */
export function typeChangeEdits(fieldIndex: number, type: FieldType, current: BlueprintField): { path: (string | number)[]; value: unknown }[] {
  const rule = FIELD_TYPE_RULES[type] ?? FIELD_TYPE_RULES.text;
  const at = (key: string): (string | number)[] => ["fields", fieldIndex, key];
  const edits: { path: (string | number)[]; value: unknown }[] = [
    { path: at("type"), value: type },
    { path: at("normalizer"), value: rule.normalizer },
    { path: at("display"), value: rule.display },
    { path: at("compare"), value: rule.compare },
    { path: [...at("capture"), "mode"], value: rule.mode },
    { path: [...at("capture"), "entity"], value: rule.entity },
  ];
  // `enumValues` is required iff the type is "enum" (FieldSchema), so it arrives with the type and leaves with it.
  if (type === "enum" && (current.enumValues ?? []).length === 0) {
    edits.push({ path: at("enumValues"), value: NEW_ENUM_VALUES.map((v) => ({ ...v })) });
  } else if (type !== "enum" && current.enumValues !== undefined) {
    edits.push({ path: at("enumValues"), value: undefined });
  }
  return edits;
}

export const FIELD_TYPE_OPTIONS: readonly FieldType[] = FIELD_TYPES;
