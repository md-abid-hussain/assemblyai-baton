/**
 * case/dates.ts - pure calendar helpers on ISO `YYYY-MM-DD` strings (UTC day arithmetic, no time zones), the
 * explicit date parser and `resolveRelativeDate` (DESIGN §5.4.1, shared with the `confirm_effective_date` handler,
 * §5.8). Re-exported by intents/add-driver.ts.
 */
import { wordsToNumbers } from "./text";

export const MONTHS = [
  "january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december",
] as const;
export const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"] as const;

const MONTH_ALIASES: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};
MONTHS.forEach((m, i) => (MONTH_ALIASES[m] = i + 1));
const MONTH_RE = `(${Object.keys(MONTH_ALIASES).sort((a, b) => b.length - a.length).join("|")})\\.?`;

const WEEKDAY_ALIASES: Record<string, number> = { sun: 0, mon: 1, tue: 2, tues: 2, wed: 3, thu: 4, thur: 4, thurs: 4, fri: 5, sat: 6 };
WEEKDAYS.forEach((d, i) => (WEEKDAY_ALIASES[d] = i));
const WEEKDAY_RE = `(${Object.keys(WEEKDAY_ALIASES).sort((a, b) => b.length - a.length).join("|")})`;

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;

/** Days since 1970-01-01 for a valid ISO date, else null. */
export function dayNumber(iso: string): number | null {
  const m = ISO_RE.exec(iso);
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  return validYmd(y, mo, d) ? Date.UTC(y, mo - 1, d) / DAY_MS : null;
}

export const isIsoDate = (s: string): boolean => dayNumber(s) !== null;

export function validYmd(y: number, m: number, d: number): boolean {
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return false;
  if (y < 1000 || y > 9999 || m < 1 || m > 12 || d < 1) return false;
  return d <= daysInMonth(y, m);
}

export const daysInMonth = (y: number, m: number): number => new Date(Date.UTC(y, m, 0)).getUTCDate();

export function isoOf(y: number, m: number, d: number): string {
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

export function fromDayNumber(n: number): string {
  const dt = new Date(n * DAY_MS);
  return isoOf(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}

/** Split a valid ISO date; throws on an invalid one (callers validate first). */
export function ymd(iso: string): { y: number; m: number; d: number } {
  const m = ISO_RE.exec(iso);
  if (!m || dayNumber(iso) === null) throw new Error(`invalid ISO date: ${iso}`);
  return { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
}

export const addDays = (iso: string, n: number): string => fromDayNumber(dayNumber(iso)! + n);
/** b − a in days. */
export const diffDays = (a: string, b: string): number => dayNumber(b)! - dayNumber(a)!;
/** 0 = Sunday … 6 = Saturday. */
export const weekdayOf = (iso: string): number => new Date(dayNumber(iso)! * DAY_MS).getUTCDay();

/** Whole years between `dob` and `on` (both ISO). */
export function ageOn(dob: string, on: string): number {
  const a = ymd(dob), b = ymd(on);
  let age = b.y - a.y;
  if (b.m < a.m || (b.m === a.m && b.d < a.d)) age -= 1;
  return age;
}

// ------------------------------------------------------------------------------------------ parsing

function prep(text: string): string {
  return wordsToNumbers(
    text
      .toLowerCase()
      .replace(/[’‘]/g, "'")
      .replace(/(\d)(st|nd|rd|th)\b/g, "$1")
      .replace(/,/g, " , ")
      .replace(/\s+/g, " ")
      .trim(),
  );
}

/** "20 26" (spoken "twenty twenty-six") → 2026; a plain 4-digit year → itself. */
function yearFrom(a: string | undefined, b: string | undefined): number | null {
  if (a && /^\d{4}$/.test(a)) return Number(a);
  if (a && b && /^(19|20)$/.test(a) && /^\d{2}$/.test(b)) return Number(a) * 100 + Number(b);
  return null;
}

export type YearlessPolicy = "future" | "past";

/**
 * Explicit calendar dates inside free text: ISO, `M/D/YYYY`, `M/D`, "March 14th, 2009", "14 March 2009",
 * "March 14", "the 14th of March". A year-less date resolves against `refDate` to the next occurrence on or after
 * it (`future`, effective dates) or the last one on or before it (`past`). Returns the first match, or null.
 */
export function parseExplicitDate(text: string, refDate: string, yearless: YearlessPolicy = "future"): string | null {
  const iso = /\b(\d{4})-(\d{1,2})-(\d{1,2})\b/.exec(text);
  if (iso) {
    const y = Number(iso[1]), m = Number(iso[2]), d = Number(iso[3]);
    return validYmd(y, m, d) ? isoOf(y, m, d) : null;
  }
  const s = prep(text);
  const slash = /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?\b/.exec(s);
  if (slash) {
    const m = Number(slash[1]), d = Number(slash[2]);
    let y: number | null = slash[3] ? Number(slash[3]) : null;
    if (y !== null && y < 100) y += y > 50 ? 1900 : 2000;
    return withYear(m, d, y, refDate, yearless);
  }
  const md = new RegExp(`\\b${MONTH_RE} (?:the )?(\\d{1,2})(?: ,)?(?: (\\d{2,4})(?: (\\d{2}))?)?\\b`).exec(s);
  if (md) {
    const m = MONTH_ALIASES[md[1]!]!, d = Number(md[2]);
    return withYear(m, d, yearFrom(md[3], md[4]), refDate, yearless);
  }
  const dm = new RegExp(`\\b(?:the )?(\\d{1,2}) (?:of )?${MONTH_RE}(?: ,)?(?: (\\d{2,4})(?: (\\d{2}))?)?\\b`).exec(s);
  if (dm) {
    const m = MONTH_ALIASES[dm[2]!]!, d = Number(dm[1]);
    return withYear(m, d, yearFrom(dm[3], dm[4]), refDate, yearless);
  }
  return null;
}

function withYear(m: number, d: number, y: number | null, refDate: string, yearless: YearlessPolicy): string | null {
  if (y !== null) return validYmd(y, m, d) ? isoOf(y, m, d) : null;
  const ref = ymd(refDate);
  for (const cand of yearless === "future" ? [ref.y, ref.y + 1] : [ref.y, ref.y - 1]) {
    if (!validYmd(cand, m, d)) continue;
    const iso = isoOf(cand, m, d);
    if (yearless === "future" ? diffDays(refDate, iso) >= 0 : diffDays(iso, refDate) >= 0) return iso;
  }
  return null;
}

/**
 * Resolve the first date expression in `words` against `callDate` (both the extractor normalizer and the
 * `confirm_effective_date` handler use this, so "this Friday" means the same thing everywhere):
 * - explicit dates first (see `parseExplicitDate`, year-less → next occurrence);
 * - "today", "tomorrow", "day after tomorrow", "in N days/weeks", "a week from today", "next week" (+7 days);
 * - weekdays: bare / "this X" = the next X strictly after today (today itself if today is X and "this"/"today"
 *   is said explicitly as "this X" on that day); "next X" = X in the following Monday-starting week;
 * - "the Nth" (day of month) = the next such day on or after today; "first of next month" / "first of the month".
 * Returns ISO or null.
 */
export function resolveRelativeDate(words: string, callDate: string): string | null {
  if (dayNumber(callDate) === null) return null;
  const explicit = parseExplicitDate(words, callDate, "future");
  if (explicit) return explicit;
  const s = prep(words);

  if (/\bday after tomorrow\b/.test(s)) return addDays(callDate, 2);
  if (/\b(tomorrow|tmrw)\b/.test(s)) return addDays(callDate, 1);
  if (/\b(today|right away|right now|immediately|this afternoon|tonight)\b/.test(s)) return callDate;

  const inN = /\bin (\d{1,3}|a|one|a couple of) (day|days|week|weeks)\b/.exec(s);
  if (inN) {
    const n = /^\d+$/.test(inN[1]!) ? Number(inN[1]) : inN[1] === "a couple of" ? 2 : 1;
    return addDays(callDate, inN[2]!.startsWith("week") ? n * 7 : n);
  }
  if (/\b(a week from (today|now)|next week)\b/.test(s) && !new RegExp(`\\bnext week ?(on )?${WEEKDAY_RE}`).test(s)) {
    return addDays(callDate, 7);
  }

  const today = weekdayOf(callDate);
  const nextWd = new RegExp(`\\bnext ${WEEKDAY_RE}\\b|\\b${WEEKDAY_RE} next week\\b|\\bnext week ?(?:on )?${WEEKDAY_RE}\\b`).exec(s);
  if (nextWd) {
    const wd = WEEKDAY_ALIASES[(nextWd[1] ?? nextWd[2] ?? nextWd[3])!]!;
    // Monday of the following week, then the requested weekday within it.
    const toNextMonday = ((8 - today) % 7) || 7;
    const nextMonday = addDays(callDate, toNextMonday);
    return addDays(nextMonday, (wd + 6) % 7);
  }
  const thisWd = new RegExp(`\\b(this |on |coming |this coming )?${WEEKDAY_RE}\\b`).exec(s);
  if (thisWd) {
    const wd = WEEKDAY_ALIASES[thisWd[2]!]!;
    const delta = (wd - today + 7) % 7;
    return addDays(callDate, delta === 0 ? (thisWd[1]?.trim() === "this" ? 0 : 7) : delta);
  }

  const { y, m } = ymd(callDate);
  if (/\b(1|first) of next month\b|\bbeginning of next month\b|\bstart of next month\b/.test(s)) {
    return m === 12 ? isoOf(y + 1, 1, 1) : isoOf(y, m + 1, 1);
  }
  const nth = /\b(?:on )?the (\d{1,2})\b(?! of)/.exec(s) ?? /\b(\d{1,2}) of (?:the|this) month\b/.exec(s);
  if (nth) {
    const d = Number(nth[1]);
    const cur = ymd(callDate);
    if (validYmd(cur.y, cur.m, d) && d >= cur.d) return isoOf(cur.y, cur.m, d);
    const ny = cur.m === 12 ? cur.y + 1 : cur.y, nm = cur.m === 12 ? 1 : cur.m + 1;
    return validYmd(ny, nm, d) ? isoOf(ny, nm, d) : null;
  }
  return null;
}
