/**
 * qa/norm.ts - the QA text normalizer (DESIGN §5.13 step 6.1) and sentence splitting (step 1).
 *
 * `norm(t)`: lowercase; `$142.00`/`$142` → `142 dollars` (`$34.10` → `34 dollars 10 cents`); spelled numbers →
 * digits (≤ 999,999); ordinals `2nd` → `2`; punctuation stripped; fillers (`uh`, `um`, `okay so`) dropped; "oh"
 * between digits → 0; "dollars and N cents" → "dollars N cents".
 */
import { wordsToNumbers } from "../case/text";

const FILLERS = new Set(["uh", "um", "uhm", "er", "erm", "hmm"]);

/** Normalized token list. */
export function normTokens(t: string): string[] {
  let s = t.toLowerCase().replace(/[’‘]/g, "'");
  s = s.replace(/\$\s?(\d[\d,]*)(?:\.(\d{1,2}))?/g, (_m, d: string, c?: string) => {
    const dollars = d.replace(/,/g, "");
    const cents = c ? c.padEnd(2, "0") : "00";
    return cents === "00" ? ` ${dollars} dollars ` : ` ${dollars} dollars ${Number(cents)} cents `;
  });
  s = s.replace(/(\d),(?=\d{3}\b)/g, "$1");
  s = s.replace(/[^\p{L}\p{N}'\s-]/gu, " ").replace(/(\s|^)-+|-+(\s|$)/g, " ");
  s = wordsToNumbers(s.replace(/\s+/g, " ").trim());
  s = s.replace(/\b(\d+)(st|nd|rd|th)\b/g, "$1").replace(/\bdollars and (\d+) cents?\b/g, "dollars $1 cents");
  const toks = s.split(/\s+/).filter(Boolean).map((w) => w.replace(/^'+|'+$/g, "")).filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i < toks.length; i++) {
    const w = toks[i]!;
    if (FILLERS.has(w)) continue;
    if (w === "okay" && toks[i + 1] === "so") { i++; continue; }
    if (w === "oh" && (/^\d+$/.test(out.at(-1) ?? "") || /^\d+$/.test(toks[i + 1] ?? ""))) { out.push("0"); continue; }
    out.push(w);
  }
  return out;
}

/** `norm(t)` as a single string. */
export const norm = (t: string): string => normTokens(t).join(" ");

const TAG_QUESTION = /^(is that (right|correct|ok|okay)|right|correct|does that sound right|sound good|ok(ay)?|yes)\?$/i;

/**
 * Split an utterance into sentences on `(?<=[.?!])\s+` (§5.13 step 1). A trailing tag question ("Is that right?")
 * is merged into the sentence before it, so "Just to confirm, X. Is that right?" is one confirmation request.
 * Returns each sentence with its char offset in `text`.
 */
export function splitSentences(text: string): { sentence: string; start: number }[] {
  const out: { sentence: string; start: number }[] = [];
  const re = /(?<=[.?!])\s+/g;
  let last = 0;
  const push = (end: number) => {
    const raw = text.slice(last, end);
    const lead = raw.length - raw.trimStart().length;
    const sentence = raw.trim();
    if (sentence) out.push({ sentence, start: last + lead });
  };
  for (let m = re.exec(text); m; m = re.exec(text)) { push(m.index); last = m.index + m[0].length; }
  push(text.length);
  const merged: { sentence: string; start: number }[] = [];
  for (const s of out) {
    const prev = merged.at(-1);
    if (prev && TAG_QUESTION.test(s.sentence)) prev.sentence = `${prev.sentence} ${s.sentence}`;
    else merged.push({ ...s });
  }
  return merged;
}
