/**
 * relay/normalizers.ts - the normalizer registry (PLATFORM §3.2 `NORMALIZERS`, §4.3). WP14a. Pure and isomorphic.
 *
 * `normalizeRaw(kind, raw, ctx)` turns what a speaker said into the normalized value (`norm`), or null when it
 * cannot be parsed. The Baton kinds CALL the legacy add-driver functions (exported unchanged from
 * intents/add-driver.ts, never re-implemented), so `buildIntentSpec(baton).normalize` equals `normalizeField` on the
 * whole corpus. The generic kinds reuse the same helpers where one exists (names, dates, money, ZIP, state, booleans).
 *
 * Blueprint regexes (enum synonyms, `validation.pattern`) are matched only through `safeTest()`.
 */
import type { AccountRecord, BlueprintField } from "../contracts/v2/blueprint";
import { safeTest } from "../contracts/v2/regex";
import { resolveRelativeDate } from "../case/dates";
import { collapseWs, wordsToNumbers } from "../case/text";
import {
  normAge, normBool, normDiscount, normDob, normIncidents, normLicenseNumber, normLicenseStatus, normName, normRelation,
  normState, normVehicle, normZip, parseMoney, speechLower,
} from "../intents/add-driver";
import { ALL_VALUE, type LookupTable } from "./formatters";

export interface NormalizerCtx {
  callDate: string;
  account: AccountRecord;
  field: BlueprintField;
  /** The field's lookup table (lookup kinds). */
  table: LookupTable | null;
}

type Normalizer = (raw: string, ctx: NormalizerCtx) => string | null;

const TEXT_MAX = 200;

function normText(raw: string): string | null {
  const s = collapseWs(raw);
  return s ? s.slice(0, TEXT_MAX) : null;
}

function inBounds(n: number, f: BlueprintField): boolean {
  const { min, max } = f.validation;
  return (min === undefined || n >= min) && (max === undefined || n <= max);
}

function normInteger(raw: string, ctx: NormalizerCtx): string | null {
  const m = /-?\d+/.exec(wordsToNumbers(speechLower(raw)).replace(/(\d),(?=\d{3}\b)/g, "$1"));
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isSafeInteger(n) && inBounds(n, ctx.field) ? String(n) : null;
}

function normNumber(raw: string, ctx: NormalizerCtx): string | null {
  const m = /-?\d+(?:\.\d+)?/.exec(wordsToNumbers(speechLower(raw)).replace(/(\d),(?=\d{3}\b)/g, "$1"));
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) && inBounds(n, ctx.field) ? String(n) : null;
}

function normMoney(signed: boolean): Normalizer {
  return (raw, ctx) => {
    const v = parseMoney(raw, signed);
    return v !== null && inBounds(Number(v), ctx.field) ? v : null;
  };
}

/** Generic enum: an exact value or label (case-insensitive, `_` = space), then each value's synonyms in order. */
function normEnum(raw: string, ctx: NormalizerCtx): string | null {
  const values = ctx.field.enumValues ?? [];
  const low = speechLower(raw);
  const s = low.replace(/_/g, " ");
  for (const e of values) if (s === e.value.replace(/_/g, " ") || s === e.label.toLowerCase()) return e.value;
  for (const e of values) for (const syn of e.synonyms) if (safeTest(syn, low)) return e.value;
  return null;
}

/** US phone: 10 digits (a leading country code 1 is dropped). Spoken digits are accepted. */
function normPhone(raw: string): string | null {
  const digits = wordsToNumbers(speechLower(raw).replace(/\b(oh|o)\b/g, "zero")).replace(/\D/g, "");
  const d = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  return /^\d{10}$/.test(d) ? d : null;
}

function normEmail(raw: string): string | null {
  const s = speechLower(raw).replace(/\s+at\s+/g, "@").replace(/\s+dot\s+/g, ".").replace(/\s+/g, "");
  return /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/.test(s) && s.length <= 120 ? s : null;
}

const tokensOf = (s: string): string[] => speechLower(s).replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter(Boolean);
const ALL_RE = /^(all|both)$|\b(all (of )?(the |our |my )?\w+|both|every (one|\w+))\b/;

/**
 * Generic lookup: a row id said directly; "all"/"both" when the field allows it; else the row whose match columns'
 * tokens appear in the raw text (the most matching columns wins; a tie is ambiguous → null).
 */
function normLookup(raw: string, ctx: NormalizerCtx): string | null {
  const t = ctx.table;
  const lk = ctx.field.lookup;
  if (!t || !lk) return null;
  const s = speechLower(raw);
  const direct = t.rows.find((r) => r[t.idColumn] !== undefined && speechLower(r[t.idColumn]!) === s);
  if (direct) return direct[t.idColumn]!;
  if (lk.allowAll && ALL_RE.test(s)) return ALL_VALUE;
  const said = new Set(tokensOf(raw));
  let best: { id: string; score: number } | null = null;
  let tie = false;
  for (const r of t.rows) {
    let score = 0;
    for (const c of lk.matchColumns) {
      const toks = tokensOf(r[c] ?? "");
      if (toks.length && toks.every((x) => said.has(x))) score++;
    }
    if (score === 0) continue;
    if (!best || score > best.score) { best = { id: r[t.idColumn] ?? "", score }; tie = false; }
    else if (score === best.score) tie = true;
  }
  return best && !tie && best.id ? best.id : null;
}

/** The legacy vehicle normalizer over the account's table rows (Baton: `tables.vehicles`). */
function normInsuranceVehicle(raw: string, ctx: NormalizerCtx): string | null {
  const rows = ctx.table?.rows ?? [];
  const vehicles = rows.map((r) => ({
    id: r.id ?? "", year: Number(r.year ?? 0), make: r.make ?? "", model: r.model ?? "", label: r.label ?? "",
  }));
  return normVehicle(raw, { vehicles });
}

const NORMALIZER_IMPLS: Readonly<Record<string, Normalizer>> = {
  text: (r) => normText(r),
  free_text_lower: (r) => speechLower(r) || null,
  person_name: (r) => normName(r),
  date: (r, c) => resolveRelativeDate(r, c.callDate),
  date_future: (r, c) => resolveRelativeDate(r, c.callDate),
  date_of_birth: (r, c) => normDob(r, c.callDate),
  integer: normInteger,
  number: normNumber,
  money: normMoney(false),
  signed_money: normMoney(true),
  enum: normEnum,
  boolean: (r) => normBool(r),
  us_phone: (r) => normPhone(r),
  us_zip5: (r) => normZip(r),
  us_state: (r) => normState(r),
  email: (r) => normEmail(r),
  id_code: (r) => normLicenseNumber(r),
  lookup: normLookup,
  "insurance.relation": (r) => normRelation(r),
  "insurance.license_status": (r) => normLicenseStatus(r),
  "insurance.vehicle": normInsuranceVehicle,
  "insurance.incidents": (r) => normIncidents(r),
  "insurance.discount": (r) => normDiscount(r),
  "insurance.age": (r) => normAge(r),
};

/** Normalizer kinds this build implements (= `NORMALIZERS`; the kernel test pins the equality). */
export const IMPLEMENTED_NORMALIZERS: readonly string[] = Object.keys(NORMALIZER_IMPLS);

/**
 * Normalizes one raw value with the field's normalizer, then applies `validation.pattern` (through `safeTest`).
 * `raw` is already trimmed and non-empty (the spec's `normalize` does that, as legacy `normalizeField` does).
 */
export function normalizeRaw(raw: string, ctx: NormalizerCtx): string | null {
  const impl = NORMALIZER_IMPLS[ctx.field.normalizer];
  if (!impl) return null;
  const norm = impl(raw, ctx);
  if (norm === null) return null;
  const pattern = ctx.field.validation.pattern;
  if (pattern !== undefined && !safeTest(pattern, norm)) return null;
  return norm;
}
