/**
 * scenarios.ts - the scenario schema (v1), loader and validator for data/scenarios/s*.json.
 *
 * The same files are (a) the role-play brief for the recording day and (b) eval ground truth.
 * data/scenarios/README.md documents every field; keep the two in sync.
 */
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { SCENARIOS_DIR } from "./paths.ts";
import { ageOn, daysBetween, isIsoDate, sha256 } from "./util.ts";

// ------------------------------------------------------------------------------------------ vocabularies

export const LANGUAGES = ["en", "hinglish"] as const;
export const DIFFICULTIES = ["easy", "medium", "hard"] as const;
export const STATUSES = ["VERIFIED", "PENDING", "MISSING"] as const;
export const RELATIONS = [
  "spouse", "domestic_partner", "child", "stepchild", "parent", "sibling",
  "other_relative", "non_relative_resident", "non_relative_nonresident",
] as const;
export const LICENSE_STATUSES = ["learner_permit", "provisional", "full"] as const;
export const OPERATOR_TYPES = ["primary", "occasional"] as const;
export const DISCOUNT_VALUES = ["eligible", "not_eligible", "pending_proof"] as const;
export const HANDOFF_RESPONSES = ["accepts", "accepts_after_question", "declines"] as const;
export const HANDOFF_AFTER = ["end_call", "rep_finishes_tail"] as const;
export const CASTING = ["any", "woman", "man"] as const;
/**
 * not_asked       - the rep skips the question; the customer doesn't volunteer it
 * customer_unsure - the rep asks once; the customer doesn't know it offhand
 * rep_holds_back  - a rep-stated value (e.g. the premium) is deliberately not said before the hand-off
 */
export const MISSING_REASONS = ["not_asked", "customer_unsure", "rep_holds_back"] as const;
export const ADVICE_TOPICS = [
  "operator_assignment", "good_student_discount", "driver_training_discount", "distant_student_discount",
  "mature_driver_discount", "coverage_limits", "permit_listing", "license_transfer", "household_listing",
  "underwriting", "garaging", "other",
] as const;
export const TAGS = [
  "golden", "baseline", "teen", "college", "spouse", "partner", "parent", "sibling", "stepchild", "other_relative",
  "non_relative", "permit", "out_of_state_license", "violation", "at_fault_accident", "underwriting_review",
  "good_student", "driver_training", "distant_student", "mature_driver", "coverage_advice", "correction",
  "missing_fact", "pending_fact", "early_handoff", "crosstalk", "interruptions", "background_noise",
  "background_voice", "declined_handoff", "accepts_after_question", "garaging_differs", "premium_decrease",
  "no_premium_change", "future_effective_date", "relative_date", "hinglish", "bilingual_rep",
] as const;

export const US_STATES = [
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "DC", "FL", "GA", "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA",
  "ME", "MD", "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ", "NM", "NY", "NC", "ND", "OH", "OK", "OR",
  "PA", "RI", "SC", "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY",
] as const;

/** Every fact field a scenario may carry. Names match the product's add_driver intent schema. */
export const FACT_FIELDS = [
  "driver_full_name", "driver_dob", "driver_age", "driver_relation",
  "license_state", "license_status", "license_number", "incidents_3y",
  "vehicle_assignment", "operator_type", "garaging_zip", "effective_date",
  "good_student_discount", "driver_training_discount", "distant_student_discount", "mature_driver_discount",
  "coverage_change", "underwriting_review",
  "premium_new_monthly_usd", "premium_change_monthly_usd", "amount_due_today_usd",
] as const;

/** Fields every add_driver scenario must define (the intent's required slots). */
export const REQUIRED_FIELDS = [
  "driver_full_name", "driver_dob", "driver_relation", "license_state", "license_status",
  "vehicle_assignment", "operator_type", "garaging_zip", "effective_date", "premium_new_monthly_usd",
] as const satisfies readonly FactField[];

export type Language = (typeof LANGUAGES)[number];
export type Status = (typeof STATUSES)[number];
export type FactField = (typeof FACT_FIELDS)[number];
export type Relation = (typeof RELATIONS)[number];
export type Tag = (typeof TAGS)[number];
export type FactValue = string | number | boolean;

type Kind =
  | { t: "string" } | { t: "date" } | { t: "int" } | { t: "state" } | { t: "zip" } | { t: "vehicle" }
  | { t: "money" } | { t: "signed_money" } | { t: "boolean" } | { t: "enum"; values: readonly string[] };

export const FIELD_KIND: Record<FactField, Kind> = {
  driver_full_name: { t: "string" },
  driver_dob: { t: "date" },
  driver_age: { t: "int" },
  driver_relation: { t: "enum", values: RELATIONS },
  license_state: { t: "state" },
  license_status: { t: "enum", values: LICENSE_STATUSES },
  license_number: { t: "string" },
  incidents_3y: { t: "string" },
  vehicle_assignment: { t: "vehicle" },
  operator_type: { t: "enum", values: OPERATOR_TYPES },
  garaging_zip: { t: "zip" },
  effective_date: { t: "date" },
  good_student_discount: { t: "enum", values: DISCOUNT_VALUES },
  driver_training_discount: { t: "enum", values: DISCOUNT_VALUES },
  distant_student_discount: { t: "enum", values: DISCOUNT_VALUES },
  mature_driver_discount: { t: "enum", values: DISCOUNT_VALUES },
  coverage_change: { t: "string" },
  underwriting_review: { t: "boolean" },
  premium_new_monthly_usd: { t: "money" },
  premium_change_monthly_usd: { t: "signed_money" },
  amount_due_today_usd: { t: "money" },
};

export const FIELD_LABEL: Record<FactField, string> = {
  driver_full_name: "New driver's full name",
  driver_dob: "Date of birth",
  driver_age: "Age",
  driver_relation: "Relationship to policyholder",
  license_state: "License state",
  license_status: "License type",
  license_number: "License number",
  incidents_3y: "Tickets / accidents (3 yrs)",
  vehicle_assignment: "Vehicle they'll drive",
  operator_type: "Primary or occasional driver",
  garaging_zip: "Garaging ZIP (where the car is kept)",
  effective_date: "Effective date",
  good_student_discount: "Good-student discount",
  driver_training_discount: "Driver-training discount",
  distant_student_discount: "Distant-student discount",
  mature_driver_discount: "Mature-driver discount",
  coverage_change: "Coverage change",
  underwriting_review: "Underwriting review needed",
  premium_new_monthly_usd: "New monthly premium",
  premium_change_monthly_usd: "Monthly premium change",
  amount_due_today_usd: "Amount due today",
};

// ------------------------------------------------------------------------------------------ types

export interface Vehicle {
  id: string;
  year: number;
  make: string;
  model: string;
  /** Who drives it most today (before the change). */
  primary_driver: string;
}

export interface Fact {
  /** Ground-truth FINAL value (after any correction), normalized to the field's kind. */
  value: FactValue;
  /** How the actor should say it (natural spoken form). Optional. */
  say_it?: string;
  /** Who first states it in the call. */
  stated_by: "customer" | "rep";
  /** Designed status at the moment the rep says the hand-off line. */
  status_at_handoff: Status;
  /** Present when the value is first said wrong and corrected mid-call. */
  correction?: {
    initial_value: FactValue;
    /** Who says the wrong value first: the customer (slip) or the rep (mis-read-back). */
    said_wrong_by: "customer" | "rep";
    how: string;
  };
  /** Required when status_at_handoff is MISSING: why it is missing. */
  missing_reason?: (typeof MISSING_REASONS)[number];
  note?: string;
}

export interface Beat {
  n: number;
  who: "rep" | "customer";
  /** Loose instruction - what to get across, not words to read. */
  beat: string;
  /** Facts established (or first mentioned) in this beat. */
  facts?: FactField[];
  /** Performance note, shown only on this speaker's card. */
  direction?: string;
  /** Marks the rep's hand-off line (exactly one beat). */
  handoff?: boolean;
  /** Marks an advice beat (the licensed-rep part). */
  advice?: boolean;
  /** Marks admin-tail beats done by the human rep after a declined hand-off. */
  tail?: boolean;
}

export interface AdviceItem {
  topic: (typeof ADVICE_TOPICS)[number];
  /** Substance the rep must get across (not verbatim). */
  rep_says: string;
  customer_decision?: string;
  /** Facts the decision sets. */
  sets?: FactField[];
}

export interface Scenario {
  schema_version: 1;
  id: string;
  title: string;
  intent: "add_driver";
  language: Language;
  language_notes?: string;
  difficulty: (typeof DIFFICULTIES)[number];
  tags: Tag[];
  /** Fictional date the call happens on; resolves "tomorrow", ages, etc. */
  call_date: string;
  target_duration_s: { min: number; max: number };
  casting: { rep: (typeof CASTING)[number]; customer: (typeof CASTING)[number]; hindi_needed: boolean };
  rep: { name: string; agency: string; agency_city: string; agency_state: string; style: string };
  customer: {
    name: string;
    persona: string;
    policy_number: string;
    policy_number_say_it?: string;
    carrier: string;
    address: { street: string; city: string; state: string; zip: string };
    existing_drivers: { name: string; relation: "named_insured" | Relation }[];
    vehicles: Vehicle[];
    current_premium_monthly_usd: number;
  };
  facts: Partial<Record<FactField, Fact>>;
  advice: AdviceItem[];
  talk_track: Beat[];
  handoff: {
    at_beat: number;
    line: string;
    customer_response: (typeof HANDOFF_RESPONSES)[number];
    customer_says: string;
    after: (typeof HANDOFF_AFTER)[number];
    approx_at_s: number;
  };
  conditions: { crosstalk?: string; interruptions?: string; background_noise?: string };
  directions: { rep: string[]; customer: string[] };
  eval: { traps: string[] };
}

export interface LoadedScenario {
  scenario: Scenario;
  file: string;
  sha256: string;
}

export interface ValidationResult {
  errors: string[];
  warnings: string[];
}

// ------------------------------------------------------------------------------------------ loading

export function scenarioFiles(dir: string = SCENARIOS_DIR): string[] {
  return readdirSync(dir)
    .filter((f) => /^s\d{2}\.json$/.test(f))
    .sort()
    .map((f) => resolve(dir, f));
}

export function loadScenarioFile(file: string): LoadedScenario {
  const text = readFileSync(file, "utf8");
  let scenario: Scenario;
  try {
    scenario = JSON.parse(text) as Scenario;
  } catch (e) {
    throw new Error(`${file}: invalid JSON (${(e as Error).message})`);
  }
  return { scenario, file, sha256: sha256(text) };
}

export function loadAllScenarios(dir: string = SCENARIOS_DIR): LoadedScenario[] {
  return scenarioFiles(dir).map((f) => loadScenarioFile(f));
}

export function findScenario(id: string, dir: string = SCENARIOS_DIR): LoadedScenario {
  const norm = /^\d{1,2}$/.test(id) ? `s${id.padStart(2, "0")}` : id.toLowerCase();
  const all = loadAllScenarios(dir);
  const hit = all.find((s) => s.scenario.id === norm);
  if (!hit) throw new Error(`scenario "${id}" not found in ${dir} (have: ${all.map((s) => s.scenario.id).join(", ")})`);
  return hit;
}

// ------------------------------------------------------------------------------------------ validation

const isStr = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;
const isMoney = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && Math.round(v * 100) === Math.round(v * 100 * 1e6) / 1e6;

function checkValue(field: FactField, v: unknown, s: Scenario): string | null {
  const k = FIELD_KIND[field];
  switch (k.t) {
    case "string": return isStr(v) ? null : "must be a non-empty string";
    case "date": return isIsoDate(v) ? null : "must be a real date YYYY-MM-DD";
    case "int": return Number.isInteger(v) ? null : "must be an integer";
    case "state": return typeof v === "string" && (US_STATES as readonly string[]).includes(v) ? null : "must be a 2-letter US state code";
    case "zip": return typeof v === "string" && /^\d{5}$/.test(v) ? null : "must be a 5-digit ZIP string";
    case "vehicle": {
      const ids = (s.customer?.vehicles ?? []).map((x) => x.id);
      return typeof v === "string" && (v === "all" || ids.includes(v)) ? null : `must be one of ${[...ids, "all"].join("|")}`;
    }
    case "money": return isMoney(v) && (v as number) >= 0 ? null : "must be a non-negative number with at most 2 decimals";
    case "signed_money": return isMoney(v) ? null : "must be a number with at most 2 decimals";
    case "boolean": return typeof v === "boolean" ? null : "must be true/false";
    case "enum": return typeof v === "string" && k.values.includes(v) ? null : `must be one of ${k.values.join("|")}`;
  }
}

/** Parse a CLI override string into the field's value kind (used by `mark --override`). */
export function parseFactValue(field: FactField, raw: string): FactValue {
  const k = FIELD_KIND[field];
  if (k.t === "int" || k.t === "money" || k.t === "signed_money") {
    const n = Number(raw.replace(/[$,]/g, ""));
    if (!Number.isFinite(n)) throw new Error(`${field} needs a number, got "${raw}"`);
    return n;
  }
  if (k.t === "boolean") {
    if (/^(true|yes|1)$/i.test(raw)) return true;
    if (/^(false|no|0)$/i.test(raw)) return false;
    throw new Error(`${field} needs true/false, got "${raw}"`);
  }
  return raw;
}

/** Validate one scenario. `fileBase` is e.g. "s01" (checked against id). */
export function validateScenario(s: Scenario, fileBase?: string): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const e = (m: string) => errors.push(m);
  const w = (m: string) => warnings.push(m);

  if (s.schema_version !== 1) e("schema_version must be 1");
  if (!/^s\d{2}$/.test(s.id ?? "")) e(`id "${s.id}" must look like s01`);
  if (fileBase && s.id !== fileBase) e(`id "${s.id}" does not match file name ${fileBase}.json`);
  if (!isStr(s.title)) e("title required");
  if (s.intent !== "add_driver") e('intent must be "add_driver"');
  if (!LANGUAGES.includes(s.language)) e(`language must be ${LANGUAGES.join("|")}`);
  if (s.language === "hinglish" && !isStr(s.language_notes)) e("hinglish scenarios need language_notes");
  if (!DIFFICULTIES.includes(s.difficulty)) e(`difficulty must be ${DIFFICULTIES.join("|")}`);
  if (!isIsoDate(s.call_date)) e("call_date must be YYYY-MM-DD");

  const td = s.target_duration_s;
  if (!td || !Number.isInteger(td.min) || !Number.isInteger(td.max) || td.min < 60 || td.max > 150 || td.min >= td.max) {
    e("target_duration_s must be integers with 60 <= min < max <= 150");
  }
  if (!s.casting || !CASTING.includes(s.casting.rep) || !CASTING.includes(s.casting.customer) || typeof s.casting.hindi_needed !== "boolean") {
    e("casting needs rep/customer (any|woman|man) and hindi_needed (boolean)");
  } else if (s.language === "hinglish" && !s.casting.hindi_needed) e("hinglish scenario must set casting.hindi_needed = true");

  // rep / customer
  for (const k of ["name", "agency", "agency_city", "agency_state", "style"] as const) if (!isStr(s.rep?.[k])) e(`rep.${k} required`);
  if (s.rep && !(US_STATES as readonly string[]).includes(s.rep.agency_state)) e("rep.agency_state must be a US state code");
  const c = s.customer;
  if (!c) e("customer required");
  else {
    for (const k of ["name", "persona", "policy_number", "carrier"] as const) if (!isStr(c[k])) e(`customer.${k} required`);
    const a = c.address;
    if (!a || !isStr(a.street) || !isStr(a.city) || !(US_STATES as readonly string[]).includes(a.state) || !/^\d{5}$/.test(a.zip ?? "")) {
      e("customer.address needs street, city, state (US code), zip (5 digits)");
    } else if (s.rep && a.state !== s.rep.agency_state) w("customer address state differs from the agency state");
    if (!Array.isArray(c.existing_drivers) || c.existing_drivers.length === 0) e("customer.existing_drivers required");
    else if (!c.existing_drivers.some((d) => d.relation === "named_insured" && d.name === c.name)) e("customer must appear in existing_drivers as named_insured");
    if (!Array.isArray(c.vehicles) || c.vehicles.length === 0) e("customer.vehicles required");
    else {
      const ids = new Set<string>();
      for (const v of c.vehicles) {
        if (!/^veh\d+$/.test(v.id ?? "")) e(`vehicle id "${v.id}" must look like veh1`);
        if (ids.has(v.id)) e(`duplicate vehicle id ${v.id}`);
        ids.add(v.id);
        if (!Number.isInteger(v.year) || v.year < 1990 || v.year > 2027) e(`vehicle ${v.id}: year looks wrong`);
        if (!isStr(v.make) || !isStr(v.model) || !isStr(v.primary_driver)) e(`vehicle ${v.id}: make, model, primary_driver required`);
      }
    }
    if (!isMoney(c.current_premium_monthly_usd) || c.current_premium_monthly_usd <= 0) e("customer.current_premium_monthly_usd must be > 0");
  }

  // facts
  const facts = s.facts ?? {};
  for (const f of REQUIRED_FIELDS) if (!facts[f]) e(`required fact "${f}" missing`);
  for (const [name, fact] of Object.entries(facts) as [FactField, Fact][]) {
    if (!(FACT_FIELDS as readonly string[]).includes(name)) {
      e(`unknown fact field "${name}"`);
      continue;
    }
    if (!fact || typeof fact !== "object") {
      e(`fact ${name} must be an object`);
      continue;
    }
    const bad = checkValue(name, fact.value, s);
    if (bad) e(`fact ${name}.value ${bad}`);
    if (fact.stated_by !== "customer" && fact.stated_by !== "rep") e(`fact ${name}.stated_by must be customer|rep`);
    if (!STATUSES.includes(fact.status_at_handoff)) e(`fact ${name}.status_at_handoff must be ${STATUSES.join("|")}`);
    if (fact.correction) {
      const cb = checkValue(name, fact.correction.initial_value, s);
      if (cb) e(`fact ${name}.correction.initial_value ${cb}`);
      if (fact.correction.initial_value === fact.value) e(`fact ${name}.correction.initial_value equals the final value`);
      if (fact.correction.said_wrong_by !== "customer" && fact.correction.said_wrong_by !== "rep") e(`fact ${name}.correction.said_wrong_by must be customer|rep`);
      if (!isStr(fact.correction.how)) e(`fact ${name}.correction.how required`);
      if (fact.status_at_handoff === "MISSING") e(`fact ${name}: a corrected fact cannot be MISSING`);
    }
    if (fact.status_at_handoff === "MISSING") {
      if (!fact.missing_reason || !MISSING_REASONS.includes(fact.missing_reason)) e(`fact ${name} is MISSING, so missing_reason must be ${MISSING_REASONS.join("|")}`);
      else if (fact.missing_reason === "rep_holds_back" && fact.stated_by !== "rep") e(`fact ${name}: rep_holds_back only applies to rep-stated facts`);
      else if (fact.missing_reason !== "rep_holds_back" && fact.stated_by !== "customer") e(`fact ${name}: ${fact.missing_reason} only applies to customer-stated facts`);
    } else if (fact.missing_reason) e(`fact ${name}: missing_reason only allowed when status_at_handoff is MISSING`);
  }

  // cross-fact consistency
  const dob = facts.driver_dob?.value;
  const age = facts.driver_age?.value;
  if (isIsoDate(dob) && isIsoDate(s.call_date)) {
    const real = ageOn(dob, s.call_date);
    if (typeof age === "number" && age !== real) e(`driver_age ${age} does not match driver_dob ${dob} on ${s.call_date} (${real})`);
    const ls = facts.license_status?.value;
    if (ls === "provisional" && real >= 18) w(`provisional license at age ${real}`);
    if (ls === "learner_permit" && real > 17) w(`learner permit at age ${real}`);
    if (real < 15) e(`driver is ${real} - too young to drive`);
  }
  const eff = facts.effective_date?.value;
  if (isIsoDate(eff) && isIsoDate(s.call_date)) {
    const d = daysBetween(s.call_date, eff);
    if (d < 0) e("effective_date is before call_date (no backdating in these scenarios)");
    if (d > 120) e("effective_date is more than 120 days after call_date");
  }
  const pNew = facts.premium_new_monthly_usd?.value;
  const pChg = facts.premium_change_monthly_usd?.value;
  if (c && typeof pNew === "number" && typeof pChg === "number") {
    if (Math.round((c.current_premium_monthly_usd + pChg) * 100) !== Math.round(pNew * 100)) {
      e(`premium mismatch: current ${c.current_premium_monthly_usd} + change ${pChg} != new ${pNew}`);
    }
  }
  if (facts.license_state && c?.address && facts.license_state.value !== c.address.state && !s.tags?.includes("out_of_state_license")) {
    e("license_state differs from the policy state but tag out_of_state_license is missing");
  }
  const gz = facts.garaging_zip?.value;
  if (c?.address && typeof gz === "string" && gz !== c.address.zip && !s.tags?.includes("garaging_differs")) {
    e("garaging_zip differs from the policy ZIP but tag garaging_differs is missing");
  }

  // advice
  if (!Array.isArray(s.advice) || s.advice.length === 0) e("advice needs at least one item");
  else {
    for (const [i, a] of s.advice.entries()) {
      if (!ADVICE_TOPICS.includes(a.topic)) e(`advice[${i}].topic must be one of ${ADVICE_TOPICS.join("|")}`);
      if (!isStr(a.rep_says)) e(`advice[${i}].rep_says required`);
      for (const f of a.sets ?? []) if (!facts[f]) e(`advice[${i}].sets references unknown fact ${f}`);
    }
  }

  // talk track
  const beats = Array.isArray(s.talk_track) ? s.talk_track : [];
  if (beats.length < 6) e("talk_track needs at least 6 beats");
  beats.forEach((b, i) => {
    if (b.n !== i + 1) e(`talk_track beat #${i + 1} has n=${b.n} (must be sequential from 1)`);
    if (b.who !== "rep" && b.who !== "customer") e(`beat ${b.n}: who must be rep|customer`);
    if (!isStr(b.beat)) e(`beat ${b.n}: beat text required`);
    for (const f of b.facts ?? []) if (!facts[f]) e(`beat ${b.n} references fact ${f} that is not in facts`);
  });
  if (!beats.some((b) => b.advice && b.who === "rep")) e("talk_track needs at least one rep beat marked advice: true");
  const hbeats = beats.filter((b) => b.handoff);
  const h = s.handoff;
  if (hbeats.length !== 1) e(`exactly one beat must have handoff: true (found ${hbeats.length})`);
  if (!h) e("handoff required");
  else {
    if (!isStr(h.line)) e("handoff.line required");
    if (!isStr(h.customer_says)) e("handoff.customer_says required");
    if (!HANDOFF_RESPONSES.includes(h.customer_response)) e(`handoff.customer_response must be ${HANDOFF_RESPONSES.join("|")}`);
    if (!HANDOFF_AFTER.includes(h.after)) e(`handoff.after must be ${HANDOFF_AFTER.join("|")}`);
    if (h.customer_response === "declines" && h.after !== "rep_finishes_tail") e("a declined hand-off must continue with after = rep_finishes_tail");
    if (h.customer_response !== "declines" && h.after !== "end_call") e("an accepted hand-off must use after = end_call");
    if (td && (h.approx_at_s < 30 || h.approx_at_s > td.max)) e("handoff.approx_at_s must be between 30 and target_duration_s.max");
    const hb = hbeats[0];
    if (hb) {
      if (hb.n !== h.at_beat) e(`handoff.at_beat=${h.at_beat} but the handoff beat is n=${hb.n}`);
      if (hb.who !== "rep") e("the handoff beat must be spoken by the rep");
      const after = beats.filter((b) => b.n > hb.n);
      if (h.after === "end_call" && after.length > 3) e("end_call scenarios should have at most 3 beats after the hand-off");
      if (h.after === "rep_finishes_tail" && after.filter((b) => b.tail).length < 3) e("rep_finishes_tail scenarios need >= 3 beats marked tail: true after the hand-off");

      // status <-> talk-track consistency (the heart of the eval ground truth)
      const firstMention = new Map<FactField, number>();
      const lastMentionBefore = new Map<FactField, number>();
      for (const b of beats) {
        for (const f of b.facts ?? []) {
          if (!firstMention.has(f)) firstMention.set(f, b.n);
          if (b.n <= hb.n) lastMentionBefore.set(f, b.n);
        }
      }
      for (const [name, fact] of Object.entries(facts) as [FactField, Fact][]) {
        const first = firstMention.get(name);
        if (fact.status_at_handoff === "MISSING") {
          if (first !== undefined && first <= hb.n) e(`fact ${name} is MISSING at hand-off but beat ${first} (before the hand-off) establishes it`);
        } else {
          const last = lastMentionBefore.get(name);
          if (last === undefined) e(`fact ${name} is ${fact.status_at_handoff} but no beat up to the hand-off (beat ${hb.n}) establishes it`);
          else if (fact.status_at_handoff === "PENDING" && last < hb.n - 2) e(`fact ${name} is PENDING, so it must be stated within the last 2 beats before the hand-off (last seen at beat ${last})`);
        }
      }
    }
  }

  // conditions / directions / eval
  if (!s.conditions || typeof s.conditions !== "object") e("conditions required (use {} when none)");
  if (!s.directions || !Array.isArray(s.directions.rep) || !Array.isArray(s.directions.customer)) e("directions.rep and directions.customer must be arrays");
  if (!s.eval || !Array.isArray(s.eval.traps) || s.eval.traps.length === 0) e("eval.traps needs at least one entry");

  // tags: vocabulary + derived-tag consistency
  const tags = new Set(s.tags ?? []);
  for (const t of tags) if (!(TAGS as readonly string[]).includes(t)) e(`unknown tag "${t}"`);
  const need = (cond: boolean, tag: Tag, why: string) => {
    if (cond && !tags.has(tag)) e(`tag "${tag}" required (${why})`);
    if (!cond && tags.has(tag)) e(`tag "${tag}" present but ${why} is not true`);
  };
  const factList = Object.values(facts) as Fact[];
  need(factList.some((f) => f.correction), "correction", "a fact has a correction");
  need(factList.some((f) => f.status_at_handoff === "MISSING"), "missing_fact", "a fact is MISSING at hand-off");
  need(factList.some((f) => f.status_at_handoff === "PENDING"), "pending_fact", "a fact is PENDING at hand-off");
  need(h?.customer_response === "declines", "declined_handoff", "the customer declines the hand-off");
  need(h?.customer_response === "accepts_after_question", "accepts_after_question", "the customer asks a question before accepting");
  need(isStr(s.conditions?.crosstalk), "crosstalk", "conditions.crosstalk is set");
  need(isStr(s.conditions?.interruptions), "interruptions", "conditions.interruptions is set");
  need(isStr(s.conditions?.background_noise), "background_noise", "conditions.background_noise is set");
  need(s.language === "hinglish", "hinglish", "language is hinglish");
  if (typeof pChg === "number") {
    need(pChg < 0, "premium_decrease", "the premium goes down");
    need(pChg === 0, "no_premium_change", "the premium change is 0");
  }
  if (facts.premium_new_monthly_usd?.status_at_handoff === "MISSING" && !tags.has("early_handoff")) e('premium MISSING at hand-off requires tag "early_handoff"');

  return { errors, warnings };
}

/** Validate every scenario plus the set-level rules (ids s01..sNN contiguous, exactly 2 Hinglish). */
export function validateAll(loaded: LoadedScenario[]): { perFile: Map<string, ValidationResult>; setErrors: string[] } {
  const perFile = new Map<string, ValidationResult>();
  const setErrors: string[] = [];
  const ids = new Set<string>();
  for (const l of loaded) {
    const base = l.file.replace(/^.*[\\/]/, "").replace(/\.json$/, "");
    perFile.set(base, validateScenario(l.scenario, base));
    if (ids.has(l.scenario.id)) setErrors.push(`duplicate id ${l.scenario.id}`);
    ids.add(l.scenario.id);
  }
  loaded.forEach((l, i) => {
    const want = `s${String(i + 1).padStart(2, "0")}`;
    if (l.scenario.id !== want) setErrors.push(`ids must be contiguous: expected ${want}, found ${l.scenario.id}`);
  });
  const hinglish = loaded.filter((l) => l.scenario.language === "hinglish").length;
  if (hinglish !== 2) setErrors.push(`expected exactly 2 hinglish scenarios, found ${hinglish}`);
  return { perFile, setErrors };
}

/** Facts grouped by designed status at hand-off (handy for eval code and cards). */
export function factsByStatus(s: Scenario): Record<Status, FactField[]> {
  const out: Record<Status, FactField[]> = { VERIFIED: [], PENDING: [], MISSING: [] };
  for (const [name, fact] of Object.entries(s.facts) as [FactField, Fact][]) out[fact.status_at_handoff].push(name);
  return out;
}
