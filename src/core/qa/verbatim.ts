/**
 * qa/verbatim.ts - the disclosure-verbatim check (DESIGN §5.13 step 6): the best token-level Levenshtein window of
 * the agent's speech against the disclosure text, `similarity = 1 − d/|D|`, and the critical tokens in that window.
 */
import { containsRun, levenshteinPrefixes } from "../case/text";
import { normTokens } from "./norm";

/** §5.13 step 6.6: `ok = similarity ≥ 0.90 ∧ no missing critical token`. */
export const VERBATIM_MIN_SIMILARITY = 0.9;

export interface VerbatimResult {
  similarity: number;
  missingCritical: string[];
  ok: boolean;
  /** Best window in `agentTokens` as [start, end). */
  window: [number, number];
}

/**
 * Best window of `agentTokens` (already normalized) against the normalized disclosure `text`, over every start and
 * every length in [0.8|D|, 1.2|D|] (one DP per start gives all lengths).
 */
export function verbatimCheck(text: string, agentTokens: readonly string[], criticalTokens: readonly string[]): VerbatimResult {
  const D = normTokens(text);
  if (!D.length) return { similarity: 1, missingCritical: [], ok: true, window: [0, 0] };
  const minL = Math.max(1, Math.floor(0.8 * D.length));
  const maxL = Math.ceil(1.2 * D.length);
  let best = { d: D.length, s: 0, L: 0 };
  for (let s = 0; s < Math.max(1, agentTokens.length); s++) {
    const avail = agentTokens.length - s;
    const hi = Math.min(maxL, avail);
    const lo = Math.min(minL, hi);
    const row = levenshteinPrefixes(D, agentTokens.slice(s, s + hi));
    for (let L = lo; L <= hi; L++) {
      const d = row[L]!;
      if (d < best.d) best = { d, s, L };
    }
  }
  const win = agentTokens.slice(best.s, best.s + best.L);
  const missingCritical = criticalTokens.filter((c) => !containsRun(win, normTokens(c)));
  const similarity = Math.max(0, 1 - best.d / D.length);
  return { similarity, missingCritical, ok: similarity >= VERBATIM_MIN_SIMILARITY && missingCritical.length === 0, window: [best.s, best.s + best.L] };
}

/** `verbatimSimilarity(text, spoken)`: the similarity alone, for a plain spoken string. */
export const verbatimSimilarity = (text: string, spoken: string): number => verbatimCheck(text, normTokens(spoken), []).similarity;
