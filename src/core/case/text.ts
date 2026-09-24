/**
 * case/text.ts - small pure text helpers shared by the normalizers (intents/add-driver.ts), evidence alignment
 * (case/apply.ts), the QA verbatim check (qa/*) and the suggested-reply engine (WP1).
 */

/** Collapse runs of whitespace to one space and trim. */
export const collapseWs = (s: string): string => s.replace(/\s+/g, " ").trim();

/** Title Case every token, also after `-` and `'` ("mary-jane o'neil" → "Mary-Jane O'Neil"). */
export const titleCase = (s: string): string =>
  s.toLowerCase().replace(/(^|[\s\-'])(\p{L})/gu, (_m, pre: string, ch: string) => pre + ch.toUpperCase());

// ------------------------------------------------------------------------------------------ number words

const UNITS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
};
const TEENS: Record<string, number> = {
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
  nineteen: 19,
};
const TENS: Record<string, number> = {
  twenty: 20, thirty: 30, forty: 40, fourty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};
const ORD_UNITS: Record<string, number> = {
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9,
};
const ORD_TEENS: Record<string, number> = {
  tenth: 10, eleventh: 11, twelfth: 12, thirteenth: 13, fourteenth: 14, fifteenth: 15, sixteenth: 16, seventeenth: 17,
  eighteenth: 18, nineteenth: 19,
};
const ORD_TENS: Record<string, number> = {
  twentieth: 20, thirtieth: 30, fortieth: 40, fiftieth: 50, sixtieth: 60, seventieth: 70, eightieth: 80, ninetieth: 90,
};

type Kind = "unit" | "teen" | "tens" | "hundred" | "thousand";
interface NumTok { kind: Kind; value: number; ordinal: boolean }

function classify(w: string): NumTok | null {
  if (w in UNITS) return { kind: "unit", value: UNITS[w]!, ordinal: false };
  if (w in TEENS) return { kind: "teen", value: TEENS[w]!, ordinal: false };
  if (w in TENS) return { kind: "tens", value: TENS[w]!, ordinal: false };
  if (w in ORD_UNITS) return { kind: "unit", value: ORD_UNITS[w]!, ordinal: true };
  if (w in ORD_TEENS) return { kind: "teen", value: ORD_TEENS[w]!, ordinal: true };
  if (w in ORD_TENS) return { kind: "tens", value: ORD_TENS[w]!, ordinal: true };
  if (w === "hundred" || w === "hundredth") return { kind: "hundred", value: 100, ordinal: w === "hundredth" };
  if (w === "thousand" || w === "thousandth") return { kind: "thousand", value: 1000, ordinal: w === "thousandth" };
  return null;
}

/**
 * Replace spelled-out numbers (up to 999,999, cardinal or ordinal) with digits, token by token. Hyphenated forms
 * ("forty-two") are split first. A unit after a unit starts a new number, so digit-by-digit speech stays separate:
 * "four four one zero seven" → "4 4 1 0 7"; "one hundred and forty-two" → "142"; "October second" → "October 2".
 * Input is expected lower-case; other tokens pass through untouched.
 */
export function wordsToNumbers(text: string): string {
  const toks = text.replace(/(\p{L})-(?=\p{L})/gu, "$1 ").split(/\s+/).filter(Boolean);
  const out: string[] = [];
  let active = false;
  let total = 0;
  let current = 0;
  let last: Kind | null = null;
  const flush = () => {
    if (active) out.push(String(total + current));
    active = false; total = 0; current = 0; last = null;
  };
  for (let i = 0; i < toks.length; i++) {
    const raw = toks[i]!;
    const m = /^([a-z]+)([.,;:!?]*)$/.exec(raw);
    const w = m?.[1] ?? raw;
    const trail = m?.[2] ?? "";
    const n = classify(w);
    if (!n) {
      if (w === "and" && active && (last === "hundred" || last === "thousand") && !trail) {
        const next = toks[i + 1];
        const nm = next ? classify(/^([a-z]+)/.exec(next)?.[1] ?? "") : null;
        if (nm && nm.kind !== "hundred" && nm.kind !== "thousand") continue;
      }
      if (w === "a" && !trail) {
        const next = toks[i + 1];
        if (next && /^(hundred|thousand)\b/.test(next)) { flush(); active = true; current = 1; last = "unit"; continue; }
      }
      flush();
      out.push(raw);
      continue;
    }
    switch (n.kind) {
      case "unit":
        if (active && last === "tens" && current % 10 === 0 && n.value !== 0) current += n.value;
        else if (active && (last === "hundred" || last === "thousand") && n.value !== 0) current += n.value;
        else { flush(); active = true; current = n.value; }
        last = "unit";
        break;
      case "teen":
      case "tens":
        if (active && (last === "hundred" || last === "thousand")) current += n.value;
        else { flush(); active = true; current = n.value; }
        last = n.kind;
        break;
      case "hundred":
        if (active && (last === "unit" || last === "teen" || last === "tens") && current > 0 && current < 100) current *= 100;
        else { flush(); out.push(raw); continue; }
        last = "hundred";
        break;
      case "thousand":
        if (active && total === 0 && current > 0 && current < 1000) { total = current * 1000; current = 0; }
        else { flush(); out.push(raw); continue; }
        last = "thousand";
        break;
    }
    if (n.ordinal || trail) {
      const wasActive = active;
      flush();
      if (wasActive && trail) out[out.length - 1] += trail;
    }
  }
  flush();
  return out.join(" ");
}

// ------------------------------------------------------------------------------------------ tokens and distances

/** Lower-case word tokens (letters/digits, apostrophes kept inside words), punctuation dropped. */
export const wordTokens = (s: string): string[] =>
  s.toLowerCase().replace(/[’‘]/g, "'").match(/[\p{L}\p{N}]+(?:['.][\p{L}\p{N}]+)*/gu) ?? [];

/** Length of the longest common subsequence of two token arrays. */
export function lcsLength(a: readonly string[], b: readonly string[]): number {
  if (!a.length || !b.length) return 0;
  let prev = new Array<number>(b.length + 1).fill(0);
  let cur = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1]! + 1 : Math.max(prev[j]!, cur[j - 1]!);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[b.length]!;
}

/**
 * Token-level edit distances of `d` against every prefix of `a`: returns `row` where `row[L]` = levenshtein(d, a[0:L]).
 * One DP gives every window length for a fixed start (used by the verbatim check).
 */
export function levenshteinPrefixes(d: readonly string[], a: readonly string[]): number[] {
  let prev = Array.from({ length: a.length + 1 }, (_, j) => j);
  let cur = new Array<number>(a.length + 1).fill(0);
  for (let i = 1; i <= d.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= a.length; j++) {
      const sub = prev[j - 1]! + (d[i - 1] === a[j - 1] ? 0 : 1);
      cur[j] = Math.min(sub, prev[j]! + 1, cur[j - 1]! + 1);
    }
    [prev, cur] = [cur, prev];
  }
  return prev;
}

/** Plain token-level Levenshtein distance. */
export const levenshtein = (a: readonly string[], b: readonly string[]): number => levenshteinPrefixes(a, b)[b.length]!;

/** Does `hay` contain `needle` as a contiguous token run? */
export function containsRun(hay: readonly string[], needle: readonly string[]): boolean {
  if (!needle.length) return true;
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}
