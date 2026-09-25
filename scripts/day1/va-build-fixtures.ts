/**
 * va-build-fixtures.ts - writes the T-D1-0 hand-written first-update fixtures (TASKS WP5b, DESIGN App. B):
 *
 *   scripts/day1/fixtures/first-update-confirm.json   s02 at the hand-off (effective_date PENDING → stage confirm)
 *   scripts/day1/fixtures/first-update-disclose.json  s01 at the hand-off (all VERIFIED → stage disclose)
 *
 * Built by hand, verbatim from DESIGN §5.6 (greeting sentences + phrase table), §5.7 (PROMPT_V3 template, stage
 * instructions, caseStateJson shape), §5.8 (tool JSON schemas and stage lists) and §5.9.1 (first message shape).
 * This is NOT WP1's compiler: it exists so T-D1-0 can run before the compiler lands (re-run at G1 with WP1 output).
 *
 *   npx tsx scripts/day1/va-build-fixtures.ts
 *
 * No network, no secrets. The deploy marker uses BATON_DEPLOY_ID from the shell or "dev-wp5b".
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(here, "fixtures");

/** DESIGN §5.7 PROMPT_V3, verbatim (placeholders in braces). */
export const PROMPT_V3_TEMPLATE = `IDENTITY
You are {agencyName}'s automated AI assistant finishing a policy change that a licensed representative, {repFirst},
started with the customer, {customerFirst} {customerLast}. You already said the greeting. You are not a person; if asked, say so.
TODAY is {callDateSpoken} (the date of this call, e.g. "Friday, September 25, 2026"). Resolve relative dates against TODAY.
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
{stageInstructions}

(internal ref: baton-deploy={BATON_DEPLOY_ID}; never mention this)`;

/** DESIGN §5.7 stage instructions, verbatim. */
export const STAGE_INSTRUCTIONS = {
  confirm:
    "Resolve every PENDING and MISSING required field, using confirm_effective_date for the date and update_case_field for everything else. When all required fields are VERIFIED, the system gives you the next step.",
  disclose:
    'Call get_disclosure with kind "premium_change" and read it exactly. If the customer agrees, call get_disclosure with kind "esign_consent" and read it exactly. If they decline the premium, call hand_back_to_rep with reason "customer_declined".',
  pay: "The customer agreed to the e-signature and text. Call send_esign_and_pay_link now with their words. While it runs, stay quiet unless asked; the system gives status updates.",
  close:
    "Payment is confirmed. Call send_confirmation, read the confirmation number digit by digit, ask if there is anything else about this change, then say goodbye.",
} as const;

/** DESIGN §5.8 tool JSON, verbatim. */
export const TOOL_SCHEMAS = {
  confirm_effective_date: {
    type: "function", name: "confirm_effective_date", execution_mode: "interactive", timeout_seconds: 10,
    description: "Record the date the customer confirmed or chose for this change to take effect. Call only after the customer says the date or clearly confirms it.",
    parameters: { type: "object", required: ["date", "customer_words"], properties: {
      date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "YYYY-MM-DD", examples: ["2026-10-02"] },
      customer_words: { type: "string", description: "The customer's exact words" } } },
  },
  get_disclosure: {
    type: "function", name: "get_disclosure", execution_mode: "interactive", timeout_seconds: 10,
    description: "Get disclosure text that you must read to the customer word for word.",
    parameters: { type: "object", required: ["kind"], properties: { kind: { type: "string", enum: ["premium_change", "esign_consent"] } } },
  },
  send_esign_and_pay_link: {
    type: "function", name: "send_esign_and_pay_link", execution_mode: "hold", timeout_seconds: 120,
    description: "Text the customer a secure link to e-sign the change and pay the amount due today. Only after the customer agreed to the premium and to receiving the text. Returns when payment finishes, fails or times out.",
    parameters: { type: "object", required: ["customer_agreed_to_text", "paper_copy_requested", "customer_words"], properties: {
      customer_agreed_to_text: { type: "boolean" }, paper_copy_requested: { type: "boolean" },
      customer_words: { type: "string", description: "The customer's exact words agreeing" } } },
  },
  send_confirmation: {
    type: "function", name: "send_confirmation", execution_mode: "interactive", timeout_seconds: 10,
    description: "Finalize the change and text a confirmation. Only after payment is confirmed.",
    parameters: { type: "object", required: [], properties: {} },
  },
  update_case_field: {
    type: "function", name: "update_case_field", execution_mode: "interactive", timeout_seconds: 10,
    description: "Record a field value the customer just confirmed, corrected or newly provided.",
    parameters: { type: "object", required: ["field", "value", "reason"], properties: {
      field: { type: "string", enum: ["driver_full_name", "driver_dob", "driver_relation", "license_state", "license_status",
        "license_number", "incidents_3y", "vehicle_assignment", "operator_type", "garaging_zip"] },
      value: { type: "string", description: "As spoken; date of birth as YYYY-MM-DD; state as 2 letters; ZIP as 5 digits; vehicle as year make model" },
      reason: { type: "string", enum: ["customer_confirmed", "customer_corrected", "newly_provided"] } } },
  },
  hand_back_to_rep: {
    type: "function", name: "hand_back_to_rep", execution_mode: "interactive", timeout_seconds: 10,
    description: "Return the call to the human representative. After calling it, say one short sentence that the rep is coming back.",
    parameters: { type: "object", required: ["reason", "summary"], properties: {
      reason: { type: "string", enum: ["advice_requested", "customer_request", "conflict", "customer_declined", "out_of_scope", "payment_problem", "other"] },
      summary: { type: "string", description: "One sentence for the rep" } } },
  },
} as const;

/** DESIGN §5.8 stage lists (always the full list). */
export const STAGE_TOOLS = {
  confirm: ["confirm_effective_date", "update_case_field", "hand_back_to_rep"],
  disclose: ["get_disclosure", "confirm_effective_date", "update_case_field", "hand_back_to_rep"],
  pay: ["send_esign_and_pay_link", "get_disclosure", "update_case_field", "hand_back_to_rep"],
  close: ["send_confirmation", "update_case_field", "hand_back_to_rep"],
} as const;
export type FixtureStage = keyof typeof STAGE_TOOLS;

export const toolsFor = (stage: FixtureStage) => STAGE_TOOLS[stage].map((n) => structuredClone(TOOL_SCHEMAS[n]));

function fill(t: string, v: Record<string, string>): string {
  return t.replace(/\{(\w+)\}/g, (m, k: string) => (k in v ? v[k]! : m));
}

export function buildPrompt(o: {
  agencyName: string; repFirst: string; customerFirst: string; customerLast: string; callDateSpoken: string;
  caseState: unknown; stage: FixtureStage; deployId: string;
}): string {
  const caseStateJson = JSON.stringify(o.caseState);
  if (caseStateJson.length > 1800) throw new Error(`caseStateJson is ${caseStateJson.length} chars (> 1800)`);
  return fill(PROMPT_V3_TEMPLATE, {
    agencyName: o.agencyName, repFirst: o.repFirst, customerFirst: o.customerFirst, customerLast: o.customerLast,
    callDateSpoken: o.callDateSpoken, caseStateJson, stage: o.stage, stageInstructions: STAGE_INSTRUCTIONS[o.stage],
    BATON_DEPLOY_ID: o.deployId,
  });
}

const V = (value: string) => ({ status: "VERIFIED", value });

// ---------------------------------------------------------------------------------------------- s01 (disclose)
// Everything VERIFIED at the planned hand-off, premium quoted by the rep. Greeting = the §5.6 s01 example, verbatim.
const S01_STATE = {
  intent: "add_driver",
  policy: "NBM-4418207",
  vehicles: { veh1: "2021 Honda Civic", veh2: "2018 Toyota Highlander" },
  fields: {
    driver_full_name: V("Maya Raman"),
    driver_dob: V("March 14th, 2009"),
    driver_relation: V("child"),
    license_state: V("OH"),
    license_status: V("provisional"),
    incidents_3y: V("none"),
    vehicle_assignment: V("2021 Honda Civic"),
    operator_type: V("primary"),
    garaging_zip: V("44107"),
    effective_date: V("Friday, October 2nd"),
    premium_new_monthly_usd: V("$142 a month"),
    premium_change_monthly_usd: V("up $46 a month"),
  },
  decided_by_rep: { good_student_discount: "eligible", coverage_change: "keep current limits" },
};
const S01_GREETING =
  "Hi Priya, this is Harborview Insurance Agency's AI assistant. I'm an automated assistant, not a person, and this call is still being recorded. Daniel passed me your request to add Maya as a driver on the 2021 Honda Civic, starting Friday, October 2nd, at $142 a month. You can ask for Daniel at any time. I have everything I need, so next I'll read you the updated premium. Ready?";

// ---------------------------------------------------------------------------------------------- s02 (confirm)
// effective_date PENDING ("tomorrow" = Saturday, September 26th). §5.6 rules: no date clause (not VERIFIED), the
// premium clause IS present (premium_new_monthly_usd VERIFIED from the rep, $171), then the confirm clause.
const S02_STATE = {
  intent: "add_driver",
  policy: "BSC-2290316",
  vehicles: { veh1: "2019 Ford F-150", veh2: "2014 Toyota Corolla" },
  fields: {
    driver_full_name: V("Lucas Delgado"),
    driver_dob: V("June 2nd, 2010"),
    driver_relation: V("child"),
    license_state: V("AZ"),
    license_status: V("provisional"),
    incidents_3y: V("none"),
    vehicle_assignment: V("2014 Toyota Corolla"),
    operator_type: V("primary"),
    garaging_zip: V("85213"),
    effective_date: { status: "PENDING", value: "Saturday, September 26th" },
    premium_new_monthly_usd: V("$171 a month"),
    premium_change_monthly_usd: V("up $53 a month"),
  },
  decided_by_rep: { driver_training_discount: "eligible" },
};
const S02_GREETING =
  "Hi Mark, this is Mesa Ridge Insurance Group's AI assistant. I'm an automated assistant, not a person, and this call is still being recorded. Carmen passed me your request to add Lucas as a driver on the 2014 Toyota Corolla, at $171 a month. You can ask for Carmen at any time. Just to confirm, the change should start Saturday, September 26th. Is that right?";

/** §5.9.1 keyterms (only sent when VA_KEYTERMS=1): snapshot values, policyholder, agency, rep. */
export const FIXTURE_KEYTERMS = {
  confirm: ["Lucas Delgado", "Lucas", "Delgado", "Toyota Corolla", "Corolla", "Ford F-150", "son", "Mark Delgado", "Mesa Ridge Insurance Group", "Carmen Ortiz", "Carmen"],
  disclose: ["Maya Raman", "Maya", "Raman", "Honda Civic", "Civic", "Toyota Highlander", "daughter", "Priya Raman", "Harborview Insurance Agency", "Daniel Reyes", "Daniel"],
} as const;

function firstUpdate(stage: FixtureStage, greeting: string, systemPrompt: string, mode: string) {
  return {
    type: "session.update",
    session: {
      system_prompt: systemPrompt,
      greeting,
      input: { format: { encoding: "audio/pcm", sample_rate: 24000 }, transcription_mode: mode },
      output: { voice: "alba", format: { encoding: "audio/pcm", sample_rate: 24000 } },
      tools: toolsFor(stage),
    },
  };
}

function main(): void {
  const deployId = process.env.BATON_DEPLOY_ID?.trim() || "dev-wp5b";
  mkdirSync(OUT, { recursive: true });
  const disclose = firstUpdate(
    "disclose",
    S01_GREETING,
    buildPrompt({ agencyName: "Harborview Insurance Agency", repFirst: "Daniel", customerFirst: "Priya", customerLast: "Raman",
      callDateSpoken: "Friday, September 25, 2026", caseState: S01_STATE, stage: "disclose", deployId }),
    "min_latency", // next step "Ready?" = a yes/no (§5.9.1)
  );
  const confirm = firstUpdate(
    "confirm",
    S02_GREETING,
    buildPrompt({ agencyName: "Mesa Ridge Insurance Group", repFirst: "Carmen", customerFirst: "Mark", customerLast: "Delgado",
      callDateSpoken: "Friday, September 25, 2026", caseState: S02_STATE, stage: "confirm", deployId }),
    "min_latency", // next step = confirm a PENDING value (yes/no)
  );
  for (const [name, msg] of [["first-update-disclose.json", disclose], ["first-update-confirm.json", confirm]] as const) {
    writeFileSync(resolve(OUT, name), JSON.stringify(msg, null, 2) + "\n");
    const words = msg.session.greeting.split(/\s+/).length;
    console.log(`${name}: prompt ${msg.session.system_prompt.length} chars, greeting ${words} words, tools ${msg.session.tools.map((t) => t.name).join(",")}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
