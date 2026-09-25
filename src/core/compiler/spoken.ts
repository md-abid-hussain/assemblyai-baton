/**
 * compiler/spoken.ts - spoken formats used by the greeting, prompt, disclosures and suggested replies
 * (DESIGN §5.6): date "Friday, October 2nd", money "$142 a month", ZIP "4 4 1 0 7", age "17", vehicle = label.
 */
import { MONTHS, WEEKDAYS, isIsoDate, weekdayOf, ymd } from "../case/dates";

const cap = (s: string): string => (s ? s[0]!.toUpperCase() + s.slice(1) : s);

export function ordinal(n: number): string {
  const v = n % 100;
  if (v >= 11 && v <= 13) return `${n}th`;
  switch (n % 10) {
    case 1: return `${n}st`;
    case 2: return `${n}nd`;
    case 3: return `${n}rd`;
    default: return `${n}th`;
  }
}

/** "2026-10-02" → "Friday, October 2nd" (effective dates, §5.6). Invalid input is returned unchanged. */
export function spokenDate(iso: string): string {
  if (!isIsoDate(iso)) return iso;
  const { m, d } = ymd(iso);
  return `${cap(WEEKDAYS[weekdayOf(iso)]!)}, ${cap(MONTHS[m - 1]!)} ${ordinal(d)}`;
}

/** "2026-09-25" → "Friday, September 25, 2026" (the prompt's TODAY line, §5.7). */
export function spokenDateLong(iso: string): string {
  if (!isIsoDate(iso)) return iso;
  const { y, m, d } = ymd(iso);
  return `${cap(WEEKDAYS[weekdayOf(iso)]!)}, ${cap(MONTHS[m - 1]!)} ${d}, ${y}`;
}

/** "2009-03-14" → "March 14th, 2009" (dates of birth). */
export function spokenDob(iso: string): string {
  if (!isIsoDate(iso)) return iso;
  const { y, m, d } = ymd(iso);
  return `${cap(MONTHS[m - 1]!)} ${ordinal(d)}, ${y}`;
}

/** "142.00" → "$142", "34.10" → "$34.10", "-12.50" → "-$12.50". Non-numeric input is returned unchanged. */
export function spokenMoney(norm: string): string {
  const n = Number(norm);
  if (!Number.isFinite(n) || norm.trim() === "") return norm;
  const abs = Math.abs(n);
  const body = Number.isInteger(abs) ? String(abs) : abs.toFixed(2);
  return `${n < 0 ? "-" : ""}$${body}`;
}

/** "142.00" → "$142 a month". */
export const spokenMonthly = (norm: string): string => `${spokenMoney(norm)} a month`;

/** Characters spaced for digit-by-digit speech: "44107" → "4 4 1 0 7", "END-48213" → "E N D 4 8 2 1 3". */
export const spokenChars = (s: string): string => s.replace(/[^A-Za-z0-9]/g, "").split("").join(" ");

/** ZIP codes are said digit by digit (§5.7 rule 8). */
export const spokenZip = (zip: string): string => spokenChars(zip);

export const STATE_NAMES: Readonly<Record<string, string>> = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado", CT: "Connecticut",
  DE: "Delaware", DC: "District of Columbia", FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho", IL: "Illinois",
  IN: "Indiana", IA: "Iowa", KS: "Kansas", KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland",
  MA: "Massachusetts", MI: "Michigan", MN: "Minnesota", MS: "Mississippi", MO: "Missouri", MT: "Montana",
  NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey", NM: "New Mexico", NY: "New York",
  NC: "North Carolina", ND: "North Dakota", OH: "Ohio", OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania",
  RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah",
  VT: "Vermont", VA: "Virginia", WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming",
};

/** "OH" → "Ohio"; unknown codes are returned unchanged. */
export const stateName = (code: string): string => STATE_NAMES[code.toUpperCase()] ?? code;
