/**
 * compiler/suggest.ts - the suggested-reply engine for the customer side of the AI half (DESIGN §5.15). Pure;
 * texts only (WP11 maps them to recorded, cached or synthetic audio and runs the autopilot timing).
 *
 * WP14a·3: `suggestReplies`, `classifyAgentText` and `askCount` take an optional trailing `spec?: IntentSpec`
 * (TASKS-v2 §2 rule 9). The `add_driver` intent (Baton, `LEGACY_BATON_SPEC` or the compiled Baton blueprint) keeps
 * today's phrase set, because WP11 maps these exact texts to recorded audio (a listed difference: no generic phrasing
 * for Baton). Every other intent gets the generic engine below: field targeting, value-bearing checks and phrases
 * from the spec, and disclosure/consent detection against the relay's rendered disclosures (compiled spec).
 */
import type { CaseState, FieldId, PaymentStatus, PolicyRecord, Stage } from "../contracts/case";
import type { Suggestion } from "../contracts/services";
import type { AccountRecord } from "../contracts/v2/blueprint";
import type { IntentSpec } from "../contracts/v2/relay";
import { titleCase } from "../case/text";
import { accountFor } from "../relay/account";
import { specFieldState, specKernelOf } from "../relay/spec-link";
import {
  compatible, confirmPhrase, firstNameOf, licenseWords, normalizeField, relationWord, targetedFields, vehicleById,
  vehicleLabelOf,
} from "../intents/add-driver";
import { isRequest, valueBearing } from "../qa/reask";
import { normTokens, splitSentences } from "../qa/norm";
import { verbatimCheck } from "../qa/verbatim";
import { spokenChars, spokenDate, spokenDob, spokenZip, stateName } from "./spoken";

export interface SuggestCtx {
  /** The agent's latest reply text. */
  lastAgentText: string;
  snapshot: Pick<CaseState, "fields">;
  /** Scenario truth, normalized (`Scenario.truth`). */
  truth: Partial<Record<FieldId, string>>;
  stage: Stage | null;
  paymentStatus: PaymentStatus | null;
  policy: PolicyRecord;
  /** Earlier agent reply texts of this AI half (the loop breaker counts repeated asks). */
  history?: readonly string[];
  /** Offer the "Try this" live-conflict chip (Watch mode, once). */
  offerTry?: boolean;
}

export type AgentTextKind = "confirm" | "ask" | "disclosure_premium" | "esign_consent" | "anything_else" | "request" | "statement";

export interface AgentTextClass {
  kind: AgentTextKind;
  sentence: string;
  field: FieldId | null;
  /** For a confirm question: the (normalized) value the agent read back, when it can be recovered. */
  value?: string | null;
}

/** Fields whose value can be recovered from a read-back sentence by the normalizer itself. */
const EXTRACTABLE: ReadonlySet<FieldId> = new Set<FieldId>([
  "garaging_zip", "vehicle_assignment", "effective_date", "driver_dob", "license_state", "license_status", "operator_type",
  "driver_relation", "driver_age",
]);

const cap = (s: string): string => (s ? s[0]!.toUpperCase() + s.slice(1) : s);
const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48);
const sugg = (text: string, kind: Suggestion["kind"]): Suggestion => ({ id: `${kind}:${slug(text)}`, text, audioUrl: null, voice: "synthetic", kind });

const ESIGN_RE = /\b(text (you )?(that|the|a) (secure )?link|paper copy|sign (this|the) change electronically)\b/i;
const PREMIUM_Q_RE = /\b(go ahead|new premium)\b/i;
const ANYTHING_ELSE_RE = /\banything else\b/i;

/**
 * Classify the agent's last request sentence (else its last sentence) with the §5.13 lexicon: which field, and
 * whether it is a confirm question (value-bearing for the snapshot or the truth value) or an open ask. WP11 calls
 * the luna fallback (§5.15 step 10) when `kind` is "request" with no field.
 */
export function classifyAgentText(text: string, ctx: Pick<SuggestCtx, "snapshot" | "truth" | "policy">, spec?: IntentSpec): AgentTextClass {
  if (spec && !isBatonIntent(spec)) return classifyGeneric(text, ctx, spec);
  const sents = splitSentences(text).map((s) => s.sentence);
  const sentence = [...sents].reverse().find(isRequest) ?? sents.at(-1) ?? "";
  if (ESIGN_RE.test(sentence) || (isRequest(sentence) && ESIGN_RE.test(text))) return { kind: "esign_consent", sentence, field: null };
  if (ANYTHING_ELSE_RE.test(sentence)) return { kind: "anything_else", sentence, field: null };
  if (!isRequest(sentence)) return { kind: "statement", sentence, field: null };
  const fields = targetedFields(sentence);
  const alternatives = /or/i.test(sentence); // "a permit, a probationary license or a full license" is an open ask
  for (const f of fields) {
    const v = ctx.snapshot.fields[f]?.value ?? null;
    const t = ctx.truth[f] ?? null;
    if (t !== null && valueBearing(sentence, f, t, ctx.policy)) return { kind: "confirm", sentence, field: f, value: t };
    if (v !== null && valueBearing(sentence, f, v, ctx.policy)) return { kind: "confirm", sentence, field: f, value: v };
    if (!alternatives && EXTRACTABLE.has(f)) {
      const x = normalizeField(f, sentence, { policy: ctx.policy, callDate: ctx.policy.callDate })?.norm ?? null;
      if (x !== null) return { kind: "confirm", sentence, field: f, value: x };
    }
  }
  if (fields.length) return { kind: "ask", sentence, field: fields[0]! };
  if (PREMIUM_Q_RE.test(sentence)) return { kind: "disclosure_premium", sentence, field: null };
  return { kind: "request", sentence, field: null };
}

/** The truthful value as the customer would say it inside a sentence ("March 14th, 2009", "the 2021 Honda Civic"). */
export function truthSpoken(field: FieldId, value: string, policy: PolicyRecord): string {
  switch (field) {
    case "driver_full_name": return titleCase(value);
    case "driver_dob": return spokenDob(value);
    case "effective_date": return spokenDate(value);
    case "garaging_zip": return spokenZip(value);
    case "license_number": return spokenChars(value);
    case "license_state": return stateName(value);
    case "license_status": return `a ${licenseWords(value)}`;
    case "vehicle_assignment": return value === "all" ? "all of them" : `the ${vehicleLabelOf(policy, value)}`;
    case "operator_type": return value === "primary" ? "every day" : "just occasionally";
    case "incidents_3y": return value === "none" ? "no tickets or accidents" : value;
    case "driver_relation": return `my ${relationWord(value)}`;
    default: return value.replace(/_/g, " ");
  }
}

/** The customer's answer to an open question about `field` (§5.15 step 3). */
export function answerFor(field: FieldId, value: string, policy: PolicyRecord, d: string): string {
  switch (field) {
    case "driver_full_name": return `It's ${titleCase(value)}.`;
    case "driver_relation": return `${d} is my ${relationWord(value)}.`;
    case "garaging_zip":
    case "license_number": return `It's ${truthSpoken(field, value, policy)}.`;
    case "effective_date": return `${spokenDate(value)}, please.`;
    case "incidents_3y": return value === "none" ? "No tickets or accidents." : `Yes: ${value}.`;
    default: return `${cap(truthSpoken(field, value, policy))}.`;
  }
}

/** The loop breaker's explicit field-plus-value sentence ("Maya's date of birth is March 14th, 2009."). */
export function explicitStatement(field: FieldId, value: string, policy: PolicyRecord, d: string, vehicleLabel: string | null = null): string {
  return `${cap(confirmPhrase(field, value, { policy, d, vehicleLabel }))}.`;
}

/** How many of the given agent texts ask about `field` (request sentences targeting it). */
export function askCount(texts: readonly string[], field: FieldId, spec?: IntentSpec): number {
  const target = spec && !isBatonIntent(spec) ? (s: string) => spec.targetedFields(s) : targetedFields;
  let n = 0;
  for (const t of texts) for (const { sentence } of splitSentences(t)) if (isRequest(sentence) && (target(sentence) as string[]).includes(field)) n++;
  return n;
}

/**
 * `suggestReplies(ctx)` (§5.15): the best reply first, then "Can I talk to {rep}?" and "Sorry, could you repeat
 * that?" always appended. Includes the loop-breaker sentence and, when offered, the "Try this" conflict chip.
 */
export function suggestReplies(ctx: SuggestCtx, spec?: IntentSpec): Suggestion[] {
  if (spec && !isBatonIntent(spec)) return suggestGeneric(ctx, spec);
  const out: Suggestion[] = [];
  const truthName = ctx.truth.driver_full_name ?? ctx.snapshot.fields.driver_full_name?.value ?? null;
  const d = truthName ? firstNameOf(truthName) : "The new driver";
  const c = classifyAgentText(ctx.lastAgentText, ctx);

  if (ctx.stage === "pay" || ctx.paymentStatus === "created" || ctx.paymentStatus === "open" || ctx.paymentStatus === "confirmed") {
    out.push(sugg("Okay, I'm paying now.", "other"));
  } else if (c.kind === "anything_else" || (ctx.stage === "close" && ctx.paymentStatus === "succeeded" && /\b(confirmation|goodbye|bye)\b/i.test(ctx.lastAgentText))) {
    out.push(sugg("No, that's everything. Thanks, bye!", "close"));
  } else if (c.kind === "esign_consent") {
    out.push(sugg("Yes, text me the link. No paper copy, thanks.", "consent"));
  } else if (c.kind === "disclosure_premium") {
    out.push(sugg("Yes, go ahead.", "consent"));
  } else if ((c.kind === "confirm" || c.kind === "ask") && c.field) {
    const f = c.field;
    const truth = ctx.truth[f] ?? null;
    const asked = askCount([...(ctx.history ?? []), ctx.lastAgentText], f);
    if (truth === null) out.push(sugg("I'm not sure, sorry.", "other"));
    else if (asked >= 2) {
      const veh = ctx.truth.vehicle_assignment;
      out.push(sugg(explicitStatement(f, truth, ctx.policy, d, veh && veh !== "all" ? vehicleLabelOf(ctx.policy, veh) : null), "answer"));
    }
    else if (c.kind === "confirm") {
      const ok = c.value !== null && c.value !== undefined && compatible(f, c.value, truth);
      out.push(ok ? sugg("Yes, that's right.", "confirm") : sugg(`No, it's ${truthSpoken(f, truth, ctx.policy)}.`, "answer"));
    } else out.push(sugg(answerFor(f, truth, ctx.policy, d), "answer"));
  } else {
    out.push(sugg("Okay.", "other"), sugg("Sure.", "other"));
  }

  if (ctx.offerTry && (ctx.stage === "confirm" || ctx.stage === "disclose")) {
    const veh = ctx.snapshot.fields.vehicle_assignment;
    const current = veh?.status === "VERIFIED" ? veh.value : null;
    const other = current ? ctx.policy.vehicles.find((v) => v.id !== current && current !== "all") : undefined;
    if (other && vehicleById(ctx.policy, current!)) out.push(sugg(`Actually, ${d} will mainly drive the ${other.model}.`, "try"));
  }
  out.push(sugg(`Can I talk to ${ctx.policy.repFirstName}?`, "handback"), sugg("Sorry, could you repeat that?", "repeat"));
  return out;
}

// ============================================================================================ generic engine (WP14a·3)

/** The Baton intent id: its customer-side phrase set stays the legacy one (see the header). */
export const BATON_INTENT_ID = "add_driver";
const isBatonIntent = (spec: IntentSpec): boolean => spec.id === BATON_INTENT_ID;

/** Field types whose value the spec's normalizer can read straight out of a read-back sentence. */
const GENERIC_EXTRACTABLE_TYPES: ReadonlySet<string> = new Set(["date", "zip", "state", "enum", "lookup", "integer"]);
/** A disclosure counts as read when the agent's text matches it at this similarity (qa/verbatim.ts). */
export const GENERIC_DISCLOSURE_MIN_SIMILARITY = 0.6;

const typeOf = (spec: IntentSpec, f: string): string | null =>
  specKernelOf(spec)?.blueprint.fields.find((x) => x.id === f)?.type ?? null;

/** Which rendered disclosure (if any) the agent's text reads: "consent" (a `consent: true` disclosure) or "disclosure". */
function disclosureRead(text: string, snapshot: Pick<CaseState, "fields">, account: AccountRecord, spec: IntentSpec): "consent" | "disclosure" | null {
  const k = specKernelOf(spec);
  if (!k) return null;
  const toks = normTokens(text);
  let best: { sim: number; consent: boolean } | null = null;
  for (const d of k.blueprint.playbook.disclosures) {
    let rendered: string;
    try { rendered = k.disclosure(d.id, { snapshot, account, opts: { taxSuffix: false } }).text; } catch { continue; }
    const sim = verbatimCheck(rendered, toks, []).similarity;
    if (sim >= GENERIC_DISCLOSURE_MIN_SIMILARITY && (!best || sim > best.sim)) best = { sim, consent: d.consent };
  }
  return best ? (best.consent ? "consent" : "disclosure") : null;
}

function classifyGeneric(text: string, ctx: Pick<SuggestCtx, "snapshot" | "truth" | "policy">, spec: IntentSpec): AgentTextClass {
  const sents = splitSentences(text).map((s) => s.sentence);
  const sentence = [...sents].reverse().find(isRequest) ?? sents.at(-1) ?? "";
  const account = accountFor(ctx.policy);
  const read = disclosureRead(text, ctx.snapshot, account, spec);
  if (read === "consent") return { kind: "esign_consent", sentence, field: null };
  if (ANYTHING_ELSE_RE.test(sentence)) return { kind: "anything_else", sentence, field: null };
  if (read === "disclosure") return { kind: "disclosure_premium", sentence, field: null };
  if (!isRequest(sentence)) return { kind: "statement", sentence, field: null };
  const fields = spec.targetedFields(sentence) as FieldId[];
  const alternatives = /\bor\b/i.test(sentence);
  for (const f of fields) {
    const t = (ctx.truth as Record<string, string | undefined>)[f] ?? null;
    const v = specFieldState(ctx.snapshot, f)?.value ?? null;
    if (t !== null && valueBearing(sentence, f, t, ctx.policy, spec)) return { kind: "confirm", sentence, field: f, value: t };
    if (v !== null && valueBearing(sentence, f, v, ctx.policy, spec)) return { kind: "confirm", sentence, field: f, value: v };
    if (!alternatives && GENERIC_EXTRACTABLE_TYPES.has(typeOf(spec, f) ?? "")) {
      const x = spec.normalize(f, sentence, { callDate: account.callDate, account })?.norm ?? null;
      if (x !== null) return { kind: "confirm", sentence, field: f, value: x };
    }
  }
  if (fields.length) return { kind: "ask", sentence, field: fields[0]! };
  return { kind: "request", sentence, field: null };
}

/** The truthful value as the customer would say it (generic: digits spaced for codes, else the field's display). */
export function genericSpoken(spec: IntentSpec, f: string, value: string, account: AccountRecord): string {
  const t = typeOf(spec, f);
  if (t === "zip" || t === "id_code" || t === "phone") return spokenChars(value);
  return spec.display(f, value, account);
}

function suggestGeneric(ctx: SuggestCtx, spec: IntentSpec): Suggestion[] {
  const out: Suggestion[] = [];
  const account = accountFor(ctx.policy);
  const c = classifyGeneric(ctx.lastAgentText, ctx, spec);
  const truthOf = (f: string): string | null => (ctx.truth as Record<string, string | undefined>)[f] ?? null;

  if (ctx.stage === "pay" || ctx.paymentStatus === "created" || ctx.paymentStatus === "open" || ctx.paymentStatus === "confirmed") {
    out.push(sugg("Okay, I'm paying now.", "other"));
  } else if (c.kind === "anything_else" || (ctx.stage === "close" && ctx.paymentStatus === "succeeded" && /\b(confirmation|goodbye|bye)\b/i.test(ctx.lastAgentText))) {
    out.push(sugg("No, that's everything. Thanks, bye!", "close"));
  } else if (c.kind === "esign_consent") {
    out.push(sugg("Yes, please text me the link.", "consent"));
  } else if (c.kind === "disclosure_premium") {
    out.push(sugg("Yes, that's fine.", "consent"));
  } else if ((c.kind === "confirm" || c.kind === "ask") && c.field) {
    const f = c.field;
    const truth = truthOf(f);
    const asked = askCount([...(ctx.history ?? []), ctx.lastAgentText], f, spec);
    if (truth === null) out.push(sugg("I'm not sure, sorry.", "other"));
    else if (asked >= 2) out.push(sugg(`${cap(spec.confirmPhrase(f, truth, { account, snapshot: ctx.snapshot }))}.`, "answer"));
    else if (c.kind === "confirm") {
      const ok = c.value !== null && c.value !== undefined && spec.compatible(f, c.value, truth);
      out.push(ok ? sugg("Yes, that's right.", "confirm") : sugg(`No, it's ${genericSpoken(spec, f, truth, account)}.`, "answer"));
    } else out.push(sugg(`It's ${genericSpoken(spec, f, truth, account)}.`, "answer"));
  } else {
    out.push(sugg("Okay.", "other"), sugg("Sure.", "other"));
  }
  out.push(sugg(`Can I talk to ${account.org.repFirstName}?`, "handback"), sugg("Sorry, could you repeat that?", "repeat"));
  return out;
}
