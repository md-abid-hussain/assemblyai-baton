/**
 * intents/add-driver.ts - the `add_driver` intent's deterministic language layer (WP1, DESIGN §5.4.1, §5.6, §5.13):
 * normalizers (`normalizeField`, `compatible`, `mergeValues`, `resolveRelativeDate`), display values, the greeting
 * phrase table (`confirmPhrase`, `askPhrase`), the QA field lexicon (`FIELD_LEXICON`) and spoken value forms
 * (`spokenForms`). Pure: no I/O, no clock.
 *
 * Norm formats equal the recording kit's value formats (so `Scenario.truth` compares directly):
 * names lower-case, dates ISO, enums as the kit enums, money "142.00", ZIP 5 digits, vehicles the policy id.
 */
import type { FieldId, PolicyRecord, PolicyVehicle } from "../contracts/case";
import { ageOn, dayNumber, diffDays, parseExplicitDate, resolveRelativeDate, ymd } from "../case/dates";
import { collapseWs, titleCase, wordTokens, wordsToNumbers } from "../case/text";
import {
  STATE_NAMES, spokenChars, spokenDate, spokenDob, spokenMoney, spokenMonthly, spokenZip, stateName,
} from "../compiler/spoken";
import {
  DISCOUNT_VALUES, FIELD_LABEL, LICENSE_STATUSES, OPERATOR_TYPES, RELATIONS, US_STATES, type DiscountValue,
  type LicenseStatus, type OperatorType, type Relation,
} from "./add-driver.fields";

export { resolveRelativeDate } from "../case/dates";

export interface NormalizeCtx {
  policy: PolicyRecord;
  /** ISO call date (the kit `call_date`); relative and year-less dates resolve against it. */
  callDate: string;
}
export interface Normalized {
  norm: string;
  display: string;
}

/**
 * §5.4.1: `callDate ≤ effective_date ≤ callDate + EFFECTIVE_DATE_MAX_DAYS`, otherwise PENDING `out_of_range`.
 * DESIGN says 60; WP1 uses 90 because the kit's own ground truth has a VERIFIED start date 84 days out (s07,
 * 2026-12-18 on a 2026-09-25 call), and a 60-day guard would make the pipeline disagree with its labels. The AI
 * half keeps its own 30-day guardrail in `confirm_effective_date` (§5.8, WP6). See docs/notes/wp1.md.
 */
export const EFFECTIVE_DATE_MAX_DAYS = 90;
/** Youngest plausible new driver (DOB year guard, §5.4.1). */
export const MIN_DRIVER_AGE = 14;
export const MIN_DOB_YEAR = 1920;

const lower = (s: string): string => collapseWs(s.toLowerCase().replace(/[’‘]/g, "'"));

// ------------------------------------------------------------------------------------------ vocabularies

/** Synonym → relation (DESIGN §5.4.1). Checked longest-first on word boundaries. */
const RELATION_SYNONYMS: ReadonlyArray<readonly [RegExp, Relation]> = [
  [/\b(step ?daughter|step ?son|step ?child|step ?kid)s?\b/, "stepchild"],
  [/\b(grand ?daughter|grand ?son|grand ?child|grand ?kid|niece|nephew|cousin|aunt|uncle|in-?law|other relative)s?\b/, "other_relative"],
  [/\b(daughter|son|child|kid|children|kids)\b/, "child"],
  [/\b(wife|husband|spouse)\b/, "spouse"],
  [/\b(domestic partner|partner)\b/, "domestic_partner"],
  [/\b(mom|mother|dad|father|mum|parent)\b/, "parent"],
  [/\b(brother|sister|sibling)\b/, "sibling"],
];
const NON_RELATIVE_RE = /\b(roommate|room mate|housemate|boyfriend|girlfriend|fianc[eé]e?|friend|nanny|babysitter|caregiver|au pair|housekeeper|tenant|boarder|employee|not related|no relation|unrelated)\b/;
const LIVES_WITH_RE = /\b(lives? with (us|me|them)|live(s)? here|in (our|my) (house|home|household)|same (house|household))\b/;
const LIVES_ELSEWHERE_RE = /\b(doesn'?t live|does not live|don'?t live|not live|lives? (elsewhere|somewhere else|on (her|his|their) own)|own (place|apartment))\b/;

const RELATION_WORD: Readonly<Record<Relation, string>> = {
  spouse: "spouse", domestic_partner: "partner", child: "child", stepchild: "stepchild", parent: "parent",
  sibling: "sibling", other_relative: "relative", non_relative_resident: "housemate",
  non_relative_nonresident: "driver from outside your household",
};
/** Specific words that may replace the generic relation word when the raw value used them. */
const RELATION_SPECIFIC: ReadonlyArray<readonly [RegExp, Relation, string]> = [
  [/\bstep ?daughter\b/, "stepchild", "stepdaughter"], [/\bstep ?son\b/, "stepchild", "stepson"],
  [/\bgrand ?daughter\b/, "other_relative", "granddaughter"], [/\bgrand ?son\b/, "other_relative", "grandson"],
  [/\bniece\b/, "other_relative", "niece"], [/\bnephew\b/, "other_relative", "nephew"], [/\bcousin\b/, "other_relative", "cousin"],
  [/\bdaughter\b/, "child", "daughter"], [/\bson\b/, "child", "son"],
  [/\bwife\b/, "spouse", "wife"], [/\bhusband\b/, "spouse", "husband"],
  [/\b(mom|mother|mum)\b/, "parent", "mother"], [/\b(dad|father)\b/, "parent", "father"],
  [/\bbrother\b/, "sibling", "brother"], [/\bsister\b/, "sibling", "sister"],
  [/\b(boyfriend)\b/, "non_relative_resident", "boyfriend"], [/\b(girlfriend)\b/, "non_relative_resident", "girlfriend"],
  [/\b(roommate|room mate)\b/, "non_relative_resident", "roommate"],
];

const LICENSE_WORDS: Readonly<Record<LicenseStatus, string>> = {
  learner_permit: "learner's permit", provisional: "probationary license", full: "full license",
};
const LICENSE_ADJ: Readonly<Record<LicenseStatus, string>> = {
  learner_permit: "learner's permit", provisional: "probationary", full: "fully licensed",
};

const MAKE_SYNONYMS: Readonly<Record<string, string>> = {
  chevy: "chevrolet", vw: "volkswagen", merc: "mercedes", benz: "mercedes", beemer: "bmw",
};

// ------------------------------------------------------------------------------------------ small helpers

export const vehicleById = (policy: PolicyRecord, id: string): PolicyVehicle | undefined =>
  policy.vehicles.find((v) => v.id === id);

/** The label of a normalized vehicle value ("veh1" → "2021 Honda Civic"; "all" → "all your vehicles"). */
export function vehicleLabelOf(policy: PolicyRecord, norm: string): string {
  if (norm === "all") return "all your vehicles";
  return vehicleById(policy, norm)?.label ?? norm;
}

/** First token of a normalized name, Title Case ("maya raman" → "Maya"). */
export const firstNameOf = (nameNorm: string): string => titleCase(nameNorm.split(" ")[0] ?? nameNorm);

export const licenseWords = (v: string): string => LICENSE_WORDS[v as LicenseStatus] ?? v.replace(/_/g, " ");
export const licenseAdjective = (v: string): string => LICENSE_ADJ[v as LicenseStatus] ?? v.replace(/_/g, " ");

/** The word for a relation, preferring the specific word the speaker used ("child" + "my daughter" → "daughter"). */
export function relationWord(value: string, raw?: string | null): string {
  if (raw) {
    const r = lower(raw);
    for (const [re, rel, word] of RELATION_SPECIFIC) if (rel === value && re.test(r)) return word;
  }
  return RELATION_WORD[value as Relation] ?? value.replace(/_/g, " ");
}

/** Is an effective date inside `callDate … callDate + EFFECTIVE_DATE_MAX_DAYS` (§5.4.1)? Non-dates are "in range" (nothing to flag). */
export function effectiveDateInRange(norm: string, callDate: string, maxDays = EFFECTIVE_DATE_MAX_DAYS): boolean {
  if (dayNumber(norm) === null || dayNumber(callDate) === null) return true;
  const d = diffDays(callDate, norm);
  return d >= 0 && d <= maxDays;
}

// ------------------------------------------------------------------------------------------ per-kind normalizers

function normName(raw: string): string | null {
  let s = raw.normalize("NFKC").toLowerCase().replace(/[’‘]/g, "'");
  s = s.replace(/\b(?:\p{L}-){1,}\p{L}\b/gu, " "); // spelled letters "m-a-y-a"
  s = s.replace(/[^\p{L}\s'-]/gu, " ");
  s = collapseWs(s.replace(/\s*-\s*/g, "-").replace(/(^|\s)['-]+|['-]+(\s|$)/g, " "));
  if (!s || !/\p{L}/u.test(s) || s.length > 80) return null;
  return s;
}

function normDob(raw: string, callDate: string): string | null {
  const iso = parseExplicitDate(raw, callDate, "past");
  if (!iso) return null;
  const { y } = ymd(iso);
  if (y < MIN_DOB_YEAR || diffDays(iso, callDate) < 0 || ageOn(iso, callDate) < MIN_DRIVER_AGE) return null;
  return iso;
}

function normAge(raw: string): string | null {
  const m = /\b(\d{1,3})\b/.exec(wordsToNumbers(lower(raw)));
  if (!m) return null;
  const n = Number(m[1]);
  return n >= MIN_DRIVER_AGE && n <= 99 ? String(n) : null;
}

function normRelation(raw: string): string | null {
  const s = lower(raw).replace(/_/g, " ");
  for (const r of RELATIONS) if (s === r.replace(/_/g, " ")) return r;
  if (/\bnon[- ]relative[- ]resident\b/.test(s)) return "non_relative_resident";
  if (/\bnon[- ]relative[- ]nonresident\b|\bnon[- ]relative[- ]non[- ]resident\b/.test(s)) return "non_relative_nonresident";
  if (NON_RELATIVE_RE.test(s)) {
    if (LIVES_ELSEWHERE_RE.test(s)) return "non_relative_nonresident";
    if (LIVES_WITH_RE.test(s) || /\b(roommate|room mate|housemate|tenant|boarder)\b/.test(s)) return "non_relative_resident";
    if (/\b(nanny|babysitter|caregiver|au pair|housekeeper|employee)\b/.test(s)) return "non_relative_nonresident";
    return null;
  }
  for (const [re, rel] of RELATION_SYNONYMS) if (re.test(s)) return rel;
  return null;
}

const STATE_BY_NAME: ReadonlyArray<readonly [string, string]> = Object.entries(STATE_NAMES)
  .map(([code, name]) => [name.toLowerCase(), code] as const)
  .sort((a, b) => b[0].length - a[0].length);

function normState(raw: string): string | null {
  const trimmed = raw.trim().replace(/\.$/, "");
  if (/^[A-Za-z]{2}$/.test(trimmed) && (US_STATES as readonly string[]).includes(trimmed.toUpperCase())) return trimmed.toUpperCase();
  const s = lower(raw);
  if (/\b(out of state|another state|different state|out-of-state)\b/.test(s) && !STATE_BY_NAME.some(([n]) => s.includes(n))) return null;
  if (/\b(d\.? ?c\.?|district of columbia|washington,? d\.?c\.?)\b/.test(s) && /\b(d\.? ?c|columbia)\b/.test(s)) return "DC";
  for (const [name, code] of STATE_BY_NAME) {
    if (new RegExp(`\\b${name.replace(/ /g, "\\s+")}\\b`).test(s)) return code;
  }
  const codes = raw.match(/\b[A-Z]{2}\b/g) ?? [];
  const valid = codes.filter((c) => (US_STATES as readonly string[]).includes(c));
  return valid.length === 1 ? valid[0]! : null;
}

function normLicenseStatus(raw: string): string | null {
  const s = lower(raw).replace(/_/g, " ");
  for (const v of LICENSE_STATUSES) if (s === v.replace(/_/g, " ")) return v;
  if (/\b(learner|learner's|learners|permit|temps|instruction permit)\b/.test(s)) return "learner_permit";
  if (/\b(probationary|provisional|junior|intermediate|graduated|restricted|probation)\b/.test(s)) return "provisional";
  if (/\b(full|regular|unrestricted|fully licensed|standard|class d|normal)\b/.test(s)) return "full";
  return null;
}

function normLicenseNumber(raw: string): string | null {
  const s = raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return s.length >= 1 && s.length <= 24 ? s : null;
}

function normIncidents(raw: string): string | null {
  const s = lower(raw).replace(/[.!]+$/, "");
  if (!s) return null;
  if (/^(none|nothing|clean|no|nope|zero|n\/a|na)$/.test(s)) return "none";
  const negStart = /^(none|nothing|no|nope|zero|never|not any|clean|she has no|he has no|they have no|there are no|there were no|she's got no|he's got no)\b/;
  if (negStart.test(s) && !/\b(but|except|although|other than|apart from|besides)\b/.test(s)) return "none";
  if (/\bclean (driving )?record\b/.test(s) && !/\b(but|except)\b/.test(s)) return "none";
  return s;
}

function normVehicle(raw: string, policy: PolicyRecord): string | null {
  const s = lower(raw);
  const direct = /\b(veh\d+)\b/.exec(s);
  if (direct && vehicleById(policy, direct[1]!)) return direct[1]!;
  if (/^(all|both)$|\b(all (of )?(the |our |my )?(cars|vehicles|of them)|both (cars|vehicles|of them)|every (car|vehicle))\b/.test(s)) return "all";
  const tokens = s.replace(/[^a-z0-9]+/g, " ").trim().split(" ").map((t) => MAKE_SYNONYMS[t] ?? t);
  const padded = ` ${tokens.join(" ")} `;
  const compactTokens = new Set(tokens);
  let best: { id: string; score: number } | null = null;
  let tie = false;
  for (const v of policy.vehicles) {
    const modelToks = v.model.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    const modelCompact = modelToks.replace(/ /g, "");
    const modelHit = padded.includes(` ${modelToks} `) || compactTokens.has(modelCompact);
    const makeHit = compactTokens.has(v.make.toLowerCase().replace(/[^a-z0-9]/g, ""));
    const yearHit = compactTokens.has(String(v.year));
    const score = (modelHit ? 4 : 0) + (makeHit ? 2 : 0) + (yearHit ? 1 : 0);
    if (score === 0) continue;
    if (!best || score > best.score) { best = { id: v.id, score }; tie = false; }
    else if (score === best.score) tie = true;
  }
  return best && !tie ? best.id : null;
}

function normOperator(raw: string): string | null {
  const s = lower(raw);
  for (const v of OPERATOR_TYPES) if (s === v) return v;
  if (/\b(occasional|occasionally|sometimes|weekends?|once in a while|now and then|rarely|here and there|every now|not often|part[- ]time)\b/.test(s)) return "occasional";
  if (/\b(primary|primarily|every ?day|daily|mainly|mostly|main driver|principal|all the time|basically (his|hers|theirs)|(his|her|their) car|full[- ]time)\b/.test(s)) return "primary";
  return null;
}

function normZip(raw: string): string | null {
  const plus4 = /\b(\d{5})-\d{4}\b/.exec(raw);
  if (plus4) return plus4[1]!;
  const s = wordsToNumbers(lower(raw).replace(/\b(oh|o)\b/g, "zero"));
  const digits = s.replace(/\D/g, "");
  return /^\d{5}$/.test(digits) ? digits : null;
}

function normEffectiveDate(raw: string, callDate: string): string | null {
  return resolveRelativeDate(raw, callDate);
}

function normDiscount(raw: string): string | null {
  const s = lower(raw).replace(/_/g, " ");
  for (const v of DISCOUNT_VALUES) if (s === v.replace(/_/g, " ")) return v;
  if (/\b(pending|proof|needs? to (send|provide|show|submit)|will send|report card|transcript|once (we|she|he|they) send|verify|verification|certificate)\b/.test(s)) return "pending_proof";
  if (/\b(not eligible|ineligible|doesn'?t qualify|does not qualify|don'?t qualify|not qualif|no|not|nope)\b/.test(s)) return "not_eligible";
  if (/\b(eligible|qualif|applies|apply|applied|yes|gets? it|included|add it)/.test(s)) return "eligible";
  return null;
}

function normBool(raw: string): string | null {
  const s = lower(raw);
  if (/^(true|yes|y|needed|required|needs review|review needed)$/.test(s) || /\b(needs?|requires?|will go to|subject to) (an? )?(underwriting|review)\b/.test(s)) return "true";
  if (/^(false|no|n|not needed|none|not required)$/.test(s) || /\b(no|not|doesn'?t need|does not need|won'?t need)\b/.test(s)) return "false";
  return null;
}

/** Money as dollars with 2 decimals. `signed` allows negatives (premium change). */
export function parseMoney(raw: string, signed: boolean): string | null {
  let s = lower(raw).replace(/(\d),(?=\d{3}\b)/g, "$1");
  s = wordsToNumbers(s.replace(/(\d)(k)\b/g, "$1000"));
  const negative = /(^|\s)-\s*\$?\d|\$-\d|\b(minus|down|less|lower|decrease[sd]?|drops?|dropped|reduc\w*|saves?|cheaper|off)\b/.test(s);
  let value: number | null = null;
  const onlyCents = /^\$?(-?\d+) cents?\b/.exec(s) ?? (!/dollar|\$/.test(s) ? /\b(-?\d+) cents?\b/.exec(s) : null);
  const dollarsCents = /(-?\d+(?:\.\d+)?) (?:dollars?|bucks)(?: and)? (\d{1,2}) (?:cents?)?/.exec(s);
  const num = /-?\$?\s?(\d+(?:\.\d+)?)/.exec(s);
  if (onlyCents && !dollarsCents) value = Math.abs(Number(onlyCents[1])) / 100;
  else if (dollarsCents) value = Math.abs(Number(dollarsCents[1])) + Number(dollarsCents[2]) / 100;
  else if (num) value = Number(num[1]);
  if (value === null || !Number.isFinite(value)) return null;
  const signedValue = negative ? -value : value;
  if (!signed && signedValue < 0) return null;
  const fixed = (Math.round(signedValue * 100) / 100).toFixed(2);
  return fixed === "-0.00" ? "0.00" : fixed;
}

// ------------------------------------------------------------------------------------------ public normalizer

/**
 * `normalizeField(field, raw, ctx) → {norm, display} | null` (DESIGN §5.4.1). `null` = unparseable: the event is
 * kept for audit with `valueNorm = null` and has no status effect. An `effective_date` outside the allowed range
 * still normalizes (the derivation flags it `out_of_range` and keeps the field PENDING).
 */
export function normalizeField(field: FieldId, raw: string | number | boolean | null | undefined, ctx: NormalizeCtx): Normalized | null {
  if (raw === null || raw === undefined) return null;
  const r = String(raw).trim();
  if (!r) return null;
  let norm: string | null;
  switch (field) {
    case "driver_full_name": norm = normName(r); break;
    case "driver_dob": norm = normDob(r, ctx.callDate); break;
    case "driver_age": norm = normAge(r); break;
    case "driver_relation": norm = normRelation(r); break;
    case "license_state": norm = normState(r); break;
    case "license_status": norm = normLicenseStatus(r); break;
    case "license_number": norm = normLicenseNumber(r); break;
    case "incidents_3y": norm = normIncidents(r); break;
    case "vehicle_assignment": norm = normVehicle(r, ctx.policy); break;
    case "operator_type": norm = normOperator(r); break;
    case "garaging_zip": norm = normZip(r); break;
    case "effective_date": norm = normEffectiveDate(r, ctx.callDate); break;
    case "good_student_discount":
    case "driver_training_discount":
    case "distant_student_discount":
    case "mature_driver_discount": norm = normDiscount(r); break;
    case "coverage_change": norm = lower(r) || null; break;
    case "underwriting_review": norm = normBool(r); break;
    case "premium_new_monthly_usd":
    case "amount_due_today_usd": norm = parseMoney(r, false); break;
    case "premium_change_monthly_usd": norm = parseMoney(r, true); break;
  }
  if (norm === null) return null;
  return { norm, display: displayValue(field, norm, ctx.policy, r) };
}

/** Human display of a normalized value (DESIGN §5.4.1 "Display" column). `raw` refines "as spoken" displays. */
export function displayValue(field: FieldId, norm: string, policy: PolicyRecord, raw?: string | null): string {
  switch (field) {
    case "driver_full_name": return titleCase(norm);
    case "driver_dob": return spokenDob(norm);
    case "driver_age": return norm;
    case "driver_relation": {
      const base = norm.replace(/_/g, " ");
      const word = relationWord(norm, raw);
      return word !== RELATION_WORD[norm as Relation] ? `${base} (${word})` : base;
    }
    case "license_state": return STATE_NAMES[norm] ? `${stateName(norm)} (${norm})` : norm;
    case "license_status": return licenseWords(norm);
    case "license_number": return spokenChars(norm);
    case "incidents_3y": return norm === "none" ? "none" : raw ? collapseWs(raw) : norm;
    case "vehicle_assignment": return vehicleLabelOf(policy, norm);
    case "operator_type": return norm;
    case "garaging_zip": return norm;
    case "effective_date": return spokenDate(norm);
    case "good_student_discount":
    case "driver_training_discount":
    case "distant_student_discount":
    case "mature_driver_discount": return norm.replace(/_/g, " ");
    case "coverage_change": return raw ? collapseWs(raw) : norm;
    case "underwriting_review": return norm;
    case "premium_new_monthly_usd":
    case "premium_change_monthly_usd": return spokenMonthly(norm);
    case "amount_due_today_usd": return spokenMoney(norm);
  }
}

/**
 * `compatible(field, a, b)` (§5.4.1): normalized equality, except `driver_full_name`, where the token set of one
 * is a subset of the other's ("maya" ⊂ "maya raman").
 */
export function compatible(field: FieldId, a: string | null, b: string | null): boolean {
  if (a === null || b === null) return false;
  if (a === b) return true;
  if (field === "driver_full_name") {
    const ta = new Set(a.split(" ")), tb = new Set(b.split(" "));
    const sub = (x: Set<string>, y: Set<string>) => [...x].every((t) => y.has(t));
    return sub(ta, tb) || sub(tb, ta);
  }
  return false;
}

/** The merged value of two compatible values: the longer name (more tokens), otherwise `b`. */
export function mergeValues(field: FieldId, a: string, b: string): string {
  if (field === "driver_full_name") {
    const na = a.split(" ").length, nb = b.split(" ").length;
    return na > nb ? a : na < nb ? b : a.length >= b.length ? a : b;
  }
  return b;
}

// ------------------------------------------------------------------------------------------ greeting phrases (§5.6)

/**
 * Greeting next-step priority (§5.6). Never includes the premium, discounts, `coverage_change` or
 * `underwriting_review`.
 */
export const GREETING_PRIORITY = [
  "driver_full_name", "driver_relation", "driver_dob", "license_state", "license_status", "incidents_3y",
  "vehicle_assignment", "operator_type", "garaging_zip", "effective_date",
] as const satisfies readonly FieldId[];

export interface PhraseCtx {
  policy: PolicyRecord;
  /** `{d}`: the VERIFIED driver's first name, else "the new driver". */
  d: string;
  /** The VERIFIED vehicle's label, else null ("the car" is used). */
  vehicleLabel: string | null;
  /** The raw words behind the value (refines relation words). */
  raw?: string | null;
}

/** `confirmPhrase(field, value)` (§5.6 phrase table). `value` is the normalized value. */
export function confirmPhrase(field: FieldId, value: string, pc: PhraseCtx): string {
  const { d } = pc;
  switch (field) {
    case "driver_full_name": return `the new driver's name is ${titleCase(value)}`;
    case "driver_relation":
      if (value === "non_relative_resident" && !/\b(roommate|boyfriend|girlfriend|room mate)\b/.test(lower(pc.raw ?? ""))) return `${d} is not related to you but lives with you`;
      if (value === "non_relative_nonresident") return `${d} is not related to you and doesn't live with you`;
      return `${d} is your ${relationWord(value, pc.raw)}`;
    case "driver_dob": return `${d}'s date of birth is ${spokenDob(value)}`;
    case "license_state": return `${d}'s license is from ${stateName(value)}`;
    case "license_status": return `${d} has a ${licenseWords(value)}`;
    case "incidents_3y":
      return value === "none"
        ? `${d} has had no tickets or accidents in the last three years`
        : `${d} has had the following in the last three years: ${value}`;
    case "vehicle_assignment":
      return value === "all" ? `${d} will drive all your vehicles` : `${d} will mainly drive the ${vehicleLabelOf(pc.policy, value)}`;
    case "operator_type": return `${d} will be the ${value} driver of the ${pc.vehicleLabel ?? "car"}`;
    case "garaging_zip": return `the car is kept at ZIP code ${spokenZip(value)}`;
    case "effective_date": return `the change should start ${spokenDate(value)}`;
    case "license_number": return `${d}'s license number is ${spokenChars(value)}`;
    case "driver_age": return `${d} is ${value}`;
    default: return `the ${FIELD_LABEL[field].toLowerCase()} is ${displayValue(field, value, pc.policy, pc.raw)}`;
  }
}

/** `askPhrase(field)` (§5.6 phrase table), completing "To finish up, I just need …". */
export function askPhrase(field: FieldId, pc: PhraseCtx): string {
  const { d } = pc;
  switch (field) {
    case "driver_full_name": return "the new driver's full name";
    case "driver_relation": return `how ${d} is related to you`;
    case "driver_dob": return `${d}'s date of birth`;
    case "license_state": return `which state issued ${d}'s license`;
    case "license_status": return `whether ${d} has a learner's permit, a probationary license or a full license`;
    case "incidents_3y": return `whether ${d} has had any tickets or accidents in the last three years`;
    case "vehicle_assignment": return `which car ${d} will mainly drive`;
    case "operator_type": return `whether ${d} will drive the ${pc.vehicleLabel ?? "car"} every day or just occasionally`;
    case "garaging_zip": return "the ZIP code where the car is kept overnight";
    case "effective_date": return "the date you'd like this change to start";
    case "license_number": return `${d}'s license number`;
    default: return `the ${FIELD_LABEL[field].toLowerCase()}`;
  }
}

// ------------------------------------------------------------------------------------------ QA lexicon (§5.13)

export interface FieldLexiconEntry {
  /** Strong ask patterns: the sentence targets this field. */
  ask: readonly RegExp[];
  /** Weak patterns: count only when no strong pattern of ANY field matched (e.g. a bare "license" or "car"). */
  weak?: readonly RegExp[];
}

/**
 * `FIELD_LEXICON[field].ask` (§5.13 step 4). The §5.13 examples are split into strong and weak patterns so a
 * generic word ("car", "license") does not also target a VERIFIED neighbour when a specific field matched
 * (e.g. "the ZIP code where the car is kept" targets garaging_zip only); see docs/notes/wp1.md.
 */
export const FIELD_LEXICON: Partial<Record<FieldId, FieldLexiconEntry>> = {
  driver_full_name: { ask: [/\b(full name|last name|first name|(her|his|their|the driver'?s|the new driver'?s) name|spell)\b/i], weak: [/\bname\b/i] },
  driver_relation: { ask: [/\b(relat\w*|your (daughter|son|wife|husband|partner|child|kid)|how do you know)\b/i] },
  driver_dob: { ask: [/\b(date of birth|birth ?date|birthday|born|how old|age|dob)\b/i] },
  license_state: { ask: [/\b(which state|what state|state (issued|is (it|the license|her license|his license) from)|issued (it|her|his|the)|licensed in)\b/i] },
  license_status: {
    ask: [/\b(permit|probationary|provisional|learner'?s|(kind|type|sort) of licen[cs]e|full licen[cs]e|licen[cs]e (type|status|class))\b/i],
    weak: [/\blicen[cs]e[ds]?\b/i],
  },
  license_number: { ask: [/\blicen[cs]e (number|no\.?|#)\b/i, /\bdriver'?s licen[cs]e number\b/i] },
  incidents_3y: { ask: [/\b(tickets?|accidents?|violations?|claims?|driving record|citations?|moving violations?)\b/i] },
  vehicle_assignment: {
    ask: [/\b(which (car|vehicle|one)|what (car|vehicle)|drive (mainly|mostly|primarily)|(mainly|mostly|primarily) drive|be driving)\b/i],
    weak: [/\b(vehicle|car)\b/i],
  },
  operator_type: { ask: [/\b(every ?day|primary|main driver|occasional\w*|how often)\b/i] },
  garaging_zip: { ask: [/\b(zip|postal|kept overnight|parked|garag\w*)\b/i] },
  effective_date: { ask: [/\b(effective|start|begin|what date|which day|when would|when should|when do you want)\b/i] },
};

/** §5.13 advice lexicon (→ `adviceFlags`; counted, never a re-ask). */
export const ADVICE_RE = /\b(recommend\w*|suggest\w*|you (should|might want to)|limits?|deductibles?|coverages?|discounts?)\b/i;

/** Fields a sentence targets (strong matches, else weak matches). */
export function targetedFields(sentence: string): FieldId[] {
  const strong: FieldId[] = [];
  const weak: FieldId[] = [];
  for (const [f, entry] of Object.entries(FIELD_LEXICON) as [FieldId, FieldLexiconEntry][]) {
    if (entry.ask.some((re) => re.test(sentence))) strong.push(f);
    else if (entry.weak?.some((re) => re.test(sentence))) weak.push(f);
  }
  return strong.length ? strong : weak;
}

// ------------------------------------------------------------------------------------------ spoken value forms

const RELATION_FORMS: Readonly<Record<Relation, readonly string[]>> = {
  child: ["daughter", "son", "child", "kid"], stepchild: ["stepdaughter", "stepson", "stepchild"],
  spouse: ["wife", "husband", "spouse"], domestic_partner: ["partner"], parent: ["mother", "father", "mom", "dad", "parent"],
  sibling: ["brother", "sister", "sibling"], other_relative: ["niece", "nephew", "cousin", "grandchild", "granddaughter", "grandson", "relative"],
  non_relative_resident: ["roommate", "housemate", "lives with you"], non_relative_nonresident: ["doesn't live with you", "not related"],
};

/**
 * Spoken forms of a normalized value (§5.13 step 5 `spokenForms`): a sentence containing any of them is
 * "value-bearing". Compared after the QA `norm()` on both sides, so "October second" ≡ "October 2nd".
 */
export function spokenForms(field: FieldId, value: string, policy: PolicyRecord): string[] {
  const forms: string[] = [];
  switch (field) {
    case "driver_full_name": forms.push(titleCase(value), firstNameOf(value)); break;
    case "driver_dob":
    case "effective_date":
      if (dayNumber(value) !== null) {
        const long = field === "driver_dob" ? spokenDob(value) : spokenDate(value);
        const md = long.replace(/^\w+day, /, "").replace(/, \d{4}$/, "");
        forms.push(long, md);
        if (field === "effective_date") forms.push(long.split(",")[0]!);
        else forms.push(String(ymd(value).y));
      } else forms.push(value);
      break;
    case "driver_age": forms.push(value); break;
    case "driver_relation": forms.push(...(RELATION_FORMS[value as Relation] ?? [value.replace(/_/g, " ")])); break;
    case "license_state": forms.push(stateName(value)); break;
    case "license_status":
      forms.push(...(value === "provisional" ? ["probationary", "provisional", "junior", "intermediate", "graduated"]
        : value === "learner_permit" ? ["learner", "permit"] : value === "full" ? ["full license", "fully licensed"] : [value]));
      break;
    case "license_number": forms.push(value, spokenChars(value)); break;
    case "incidents_3y": forms.push(...(value === "none" ? ["no tickets", "no accidents", "clean record"] : [value])); break;
    case "vehicle_assignment": {
      const v = vehicleById(policy, value);
      if (v) forms.push(v.model, v.label, `${v.make} ${v.model}`);
      else forms.push(value === "all" ? "all" : value);
      break;
    }
    case "operator_type":
      forms.push(...((value as OperatorType) === "primary" ? ["primary", "every day", "main driver", "mainly"] : ["occasional", "occasionally", "sometimes"]));
      break;
    case "garaging_zip": forms.push(value, spokenZip(value)); break;
    case "premium_new_monthly_usd":
    case "premium_change_monthly_usd":
    case "amount_due_today_usd": forms.push(spokenMoney(value)); break;
    default: forms.push(value.replace(/_/g, " "));
  }
  return [...new Set(forms.filter(Boolean))];
}

/** Word tokens helper re-exported for consumers that match spoken forms. */
export { wordTokens };
/** Type re-exports for convenience. */
export type { DiscountValue, LicenseStatus, OperatorType, Relation };
