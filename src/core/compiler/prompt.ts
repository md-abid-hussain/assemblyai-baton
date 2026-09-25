/**
 * compiler/prompt.ts - the Voice Agent system prompt (`PROMPT_V3`, DESIGN §5.7).
 *
 * The last line is the deploy marker read by the F6 audit; it is excluded from `PROMPT_VERSION`
 * (= sha256(template + stage instructions).slice(0, 8)).
 */
import type { CaseState, FieldId, PolicyRecord, Stage } from "../contracts/case";
import type { IntentSpec } from "../contracts/v2/relay";
import { sha256Hex } from "../case/sha256";
import { ADVICE_DOMAIN_SET, FIELD_IDS, REQUIRED_SET } from "../intents/add-driver.fields";
import { accountFor } from "../relay/account";
import { kernelOrLegacy } from "../relay/spec-link";
import { spokenDateLong } from "./spoken";
import type { PayToolMode } from "./tool-schemas";

/** The template, verbatim from §5.7 (placeholders in braces; the marker line is appended separately). */
export const PROMPT_V3 = `IDENTITY
You are {agencyName}'s automated AI assistant finishing a policy change that a licensed representative, {repFirst},
started with the customer, {customerFirst} {customerLast}. You already said the greeting. You are not a person; if asked, say so.
TODAY is {callDateSpoken} (the date of this call). Resolve relative dates against TODAY.
You handle ADMINISTRATIVE steps only. You never give insurance advice, never recommend coverages, limits or deductibles,
and never explain what is or isn't covered. If the customer asks for advice or anything outside this change, call
hand_back_to_rep with reason "advice_requested" (or "out_of_scope").

CASE STATE (authoritative; VERIFIED = already confirmed with the customer)
{caseStateJson}

RULES
1. Never ask for a VERIFIED field, and never ask the customer to repeat it.
2. Confirm PENDING fields one at a time by reading the value back. If the customer confirms or corrects it, call update_case_field.
3. Ask for MISSING fields one at a time; when answered, call update_case_field.
4. If the customer disputes a VERIFIED value, call update_case_field with their value and reason "customer_corrected";
   if the result is "conflict", read back the recorded value, ask which is right, and call update_case_field again with
   reason "customer_corrected" only if they insist. Never silently change a VERIFIED value.
5. State a premium, amount or date ONLY if it comes from CASE STATE or a tool result. Never estimate or compute money.
6. When a tool returns disclosure text, read it EXACTLY as written, word for word, then stop and wait for the answer.
7. Never ask for, repeat, or accept card numbers, bank details or passwords. Payment happens only through the secure link.
   If the customer starts reading a card number, stop them politely and explain the link.
8. One question per turn. Short sentences. Natural US English. Say ZIP codes digit by digit.
9. If the customer asks for {repFirst}, or is upset or confused twice, call hand_back_to_rep.
10. Discounts, coverage limits, deductibles and underwriting are {repFirst}'s decisions. Never offer, re-offer or
    change them; if the customer brings them up, say {repFirst} will follow up, or call hand_back_to_rep.

CURRENT STAGE: {stage}
{stageInstructions}`;

/** §5.7 stage instructions (the `pay` text is for PAY_TOOL_MODE=hold). */
export const STAGE_INSTRUCTIONS: Readonly<Record<Stage, string>> = {
  confirm:
    "Resolve every PENDING and MISSING required field, using confirm_effective_date for the date and update_case_field for everything else. When all required fields are VERIFIED, the system gives you the next step.",
  disclose:
    'Call get_disclosure with kind "premium_change" and read it exactly. If the customer agrees, call get_disclosure with kind "esign_consent" and read it exactly. If they decline the premium, call hand_back_to_rep with reason "customer_declined".',
  pay: "The customer agreed to the e-signature and text. Call send_esign_and_pay_link now with their words. While it runs, stay quiet unless asked; the system gives status updates.",
  close:
    "Payment is confirmed. Call send_confirmation, read the confirmation number digit by digit, ask if there is anything else about this change, then say goodbye.",
};

/**
 * `pay` instructions under PAY_TOOL_MODE=push (§5.8; the production mode since T-D1-1): the tool returns at once; the
 * agent says one sentence and waits. Wording as WP5b validated live (wp5b-to-wp1 item 1).
 */
export const PAY_PUSH_INSTRUCTIONS =
  "The customer agreed to the e-signature and text. Call send_esign_and_pay_link now with their words. When it returns, tell the customer in one short sentence that you texted the secure link and will wait while they sign and pay. Then stay quiet unless asked; the system gives status updates.";

/** Version of the prompt template (marker excluded), stored on the takeover. */
export const PROMPT_VERSION: string = sha256Hex(`${PROMPT_V3}\n${JSON.stringify(STAGE_INSTRUCTIONS)}\n${PAY_PUSH_INSTRUCTIONS}`).slice(0, 8);

/** §5.7 cap on the case JSON. */
export const CASE_STATE_JSON_MAX = 1800;

export const deployMarkerOf = (deployId: string): string => `baton-deploy=${deployId}`;
export const deployMarkerLine = (deployId: string): string => `(internal ref: ${deployMarkerOf(deployId)}; never mention this)`;

const MONEY_FIELDS_IN_PROMPT: ReadonlySet<FieldId> = new Set<FieldId>(["premium_new_monthly_usd", "premium_change_monthly_usd", "amount_due_today_usd"]);

/**
 * `caseStateJson` (§5.7): compact JSON, ≤ 1800 chars. The 10 required fields plus any non-MISSING optional
 * field; advice-domain fields go under `decided_by_rep` (read-only context). Money fields appear only when the REP
 * quoted them (VERIFIED from the rep), never otherwise, and never as MISSING.
 *
 * WP14a·3: with `spec` = a compiled relay's spec (`compileRelay(bp).spec`), the kernel's case JSON of that relay
 * (`promptVisibility`, `caseJson.{header,tables,maxChars}`); `LEGACY_BATON_SPEC` keeps this code. Parity: equal for Baton.
 */
export function caseStateJson(state: Pick<CaseState, "fields">, policy: PolicyRecord, spec?: IntentSpec): string {
  const k = kernelOrLegacy(spec, "caseStateJson");
  if (k) return k.caseJson(state, accountFor(policy));
  const vehicles = Object.fromEntries(policy.vehicles.map((v) => [v.id, v.label]));
  const fields: Record<string, { status: string; value?: string }> = {};
  const optional: string[] = [];
  const decided: Record<string, string> = {};
  for (const f of FIELD_IDS) {
    const st = state.fields[f];
    if (!st) continue;
    if (ADVICE_DOMAIN_SET.has(f)) {
      if (st.status !== "MISSING" && st.value !== null) decided[f] = st.display ?? st.value;
      continue;
    }
    if (MONEY_FIELDS_IN_PROMPT.has(f)) {
      if (st.status === "VERIFIED" && st.source === "rep" && st.value !== null) {
        fields[f] = { status: "VERIFIED", value: st.display ?? st.value };
        if (!REQUIRED_SET.has(f)) optional.push(f);
      }
      continue;
    }
    if (REQUIRED_SET.has(f) || st.status !== "MISSING") {
      fields[f] = st.status === "MISSING" || st.value === null ? { status: "MISSING" } : { status: st.status, value: st.display ?? st.value };
      if (!REQUIRED_SET.has(f)) optional.push(f);
    }
  }
  const render = () =>
    JSON.stringify({
      intent: "add_driver",
      policy: policy.policyNumber,
      vehicles,
      fields,
      ...(Object.keys(decided).length ? { decided_by_rep: decided } : {}),
    });
  let json = render();
  // Over the cap: drop optional fields (last first), then rep decisions, then shorten long values.
  while (json.length > CASE_STATE_JSON_MAX && optional.length) { delete fields[optional.pop()!]; json = render(); }
  for (const k of Object.keys(decided).reverse()) { if (json.length <= CASE_STATE_JSON_MAX) break; delete decided[k]; json = render(); }
  for (const max of [60, 30, 12]) {
    if (json.length <= CASE_STATE_JSON_MAX) break;
    for (const v of Object.values(fields)) if (v.value && v.value.length > max) v.value = `${v.value.slice(0, max - 1)}…`;
    json = render();
  }
  return json;
}

export interface CompilePromptOptions {
  /** BATON_DEPLOY_ID, embedded in the marker line (F6 audit). */
  deployId: string;
  payToolMode?: PayToolMode;
}

/** `compilePrompt(state, policy, stage, {deployId})` (§5.7) → the full system prompt text. */
export function compilePrompt(state: Pick<CaseState, "fields">, policy: PolicyRecord, stage: Stage, opts: CompilePromptOptions): string {
  const stageInstructions = stage === "pay" && opts.payToolMode === "push" ? PAY_PUSH_INSTRUCTIONS : STAGE_INSTRUCTIONS[stage];
  const values: Record<string, string> = {
    agencyName: policy.agencyName,
    repFirst: policy.repFirstName,
    customerFirst: policy.policyholder.firstName,
    customerLast: policy.policyholder.lastName,
    callDateSpoken: spokenDateLong(policy.callDate),
    caseStateJson: caseStateJson(state, policy),
    stage,
    stageInstructions,
  };
  const body = PROMPT_V3.replace(/\{(\w+)\}/g, (m, k: string) => values[k] ?? m);
  return `${body}\n\n${deployMarkerLine(opts.deployId)}`;
}
