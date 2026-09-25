/**
 * qa/reask.ts - request detection, field targeting and the per-sentence classification of §5.13 steps 3–5.
 *
 * WP14a·3: `isAdvice`, `valueBearing`, `classifyAsk` and `classifySentence` take an optional trailing
 * `spec?: IntentSpec` (TASKS-v2 §2 rule 9): the spec's QA lexicon, advice lexicon and spoken forms.
 */
import type { CaseState, FieldId, PolicyRecord } from "../contracts/case";
import type { IntentSpec } from "../contracts/v2/relay";
import { containsRun } from "../case/text";
import { ADVICE_RE, spokenForms, targetedFields } from "../intents/add-driver";
import { accountFor } from "../relay/account";
import { specAdvice } from "../relay/spec-link";
import { normTokens } from "./norm";

export { targetedFields } from "../intents/add-driver";

const REQ_START = /^(can|could|would|will|may|do|does|did|is|are|was|what|what's|which|when|where|how|who)\b/i;
const REQ_ANY = /\b(please (tell|confirm|give|provide|spell)|i (just )?need|can i (get|have)|could i (get|have)|let me get)\b/i;

/** §5.13 step 3: ends with `?`, starts with a question word, or contains a request phrase. */
export function isRequest(s: string): boolean {
  const t = s.trim();
  return /\?\s*$/.test(t) || REQ_START.test(t) || REQ_ANY.test(t);
}

/** Does the sentence advise (§5.13 advice lexicon; counted as `adviceFlags`, never a re-ask)? */
export const isAdvice = (s: string, spec?: IntentSpec): boolean => (spec ? specAdvice(spec, s) : ADVICE_RE.test(s));

/** §5.13 step 5: the sentence contains a spoken form of `value` (compared after `norm()` on both sides). */
export function valueBearing(sentence: string, field: FieldId, value: string, policy: PolicyRecord, spec?: IntentSpec): boolean {
  const toks = normTokens(sentence);
  const forms = spec ? spec.spokenForms(field, value, accountFor(policy)) : spokenForms(field, value, policy);
  return forms.some((f) => {
    const ft = normTokens(f);
    return ft.length > 0 && containsRun(toks, ft);
  });
}

export type ReaskClass = "reask" | "verified_reconfirm" | "pending_confirm" | "new";

/** Classification of one (request sentence, targeted field) by the snapshot status (§5.13 step 5 table). */
export function classifyAsk(sentence: string, field: FieldId, snapshot: Pick<CaseState, "fields">, policy: PolicyRecord, spec?: IntentSpec): ReaskClass {
  const st = snapshot.fields[field];
  if (!st || st.status === "MISSING" || st.value === null) return "new";
  if (st.status === "PENDING") return "pending_confirm";
  return valueBearing(sentence, field, st.value, policy, spec) ? "verified_reconfirm" : "reask";
}

export interface SentenceClass {
  isRequest: boolean;
  advice: boolean;
  fields: { field: FieldId; classification: ReaskClass }[];
}

/** Classify one agent sentence (steps 3–5 together). */
export function classifySentence(sentence: string, snapshot: Pick<CaseState, "fields">, policy: PolicyRecord, spec?: IntentSpec): SentenceClass {
  const req = isRequest(sentence);
  const targeted = !req ? [] : spec ? (spec.targetedFields(sentence) as FieldId[]) : targetedFields(sentence);
  const fields = targeted.map((field) => ({ field, classification: classifyAsk(sentence, field, snapshot, policy, spec) }));
  return { isRequest: req, advice: isAdvice(sentence, spec), fields };
}
