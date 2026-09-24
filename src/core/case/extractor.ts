/**
 * case/extractor.ts - the `gpt-6-luna` JSON-patch extractor's artefacts (DESIGN §5.3): the verbatim instructions
 * (`EXTRACTOR_PROMPT_V3`, and the naive `EXTRACTOR_PROMPT_V1` of the v1 pipeline, §6.4), the strict output format
 * (`ADD_DRIVER_PATCH_FORMAT`), the user-input builder and the version pin. WP3's `Extractor` and WP9's caches use
 * these; the model call itself lives in src/server/openai/extractor.ts (WP3).
 */
import type { CaseState, PolicyRecord } from "../contracts/case";
import type { TurnInput } from "../contracts/turns";
import { FIELD_IDS, REQUIRED_SET } from "../intents/add-driver.fields";
import { WEEKDAYS, weekdayOf } from "./dates";
import { sha256Hex } from "./sha256";

export const EXTRACTOR_PROMPT_V3 = `You extract facts for an insurance policy-change case from a phone call between an agency REP and a policyholder CUSTOMER.
Intent: add a driver to a personal auto policy. You see the current case, recent turns, and one or more NEW TURNS.
Emit events ONLY for what the NEW TURNS say. Never repeat facts from earlier turns unless a NEW TURN restates, reads back,
confirms, corrects or denies them. Never invent values. If nothing relevant is said, return {"events": [], "no_facts": true}.

Fields (value formats):
- driver_full_name: the new driver's name as spoken ("Maya", "Maya Raman").
- driver_dob: YYYY-MM-DD.            - driver_age: integer years ("17").
- driver_relation: one of spouse, domestic_partner, child, stepchild, parent, sibling, other_relative,
  non_relative_resident, non_relative_nonresident.
- license_state: 2-letter US state code ("OH").   - license_number: as spoken, digits/letters only.
- license_status: one of learner_permit, provisional (probationary), full.
- incidents_3y: "none", or a short description of tickets/accidents/claims in the last 3 years.
- vehicle_assignment: the policy vehicle the new driver will mainly drive, as its id from POLICY VEHICLES ("veh1").
- operator_type: primary or occasional (for that vehicle).
- garaging_zip: 5-digit ZIP where that vehicle is kept overnight.
- effective_date: YYYY-MM-DD. Resolve relative dates ("tomorrow", "next Friday") against CALL DATE.
- good_student_discount, driver_training_discount, distant_student_discount, mature_driver_discount:
  eligible, not_eligible or pending_proof.
- coverage_change: short text of what the customer decided about coverage ("keep current limits").
- underwriting_review: "true" or "false".
- premium_new_monthly_usd, premium_change_monthly_usd, amount_due_today_usd: dollars with cents ("142.00", "-12.50").
  Only the REP can state these.
Event kinds:
- stated: the speaker gives a value, or proposes one in a question ("Is that the Civic?").
- readback: the speaker repeats a value the OTHER party gave, to check it.
- ack: the speaker affirms the other party's latest statement/readback ("yes", "that's right", "correct"). Set
  acknowledges_turn_id to that turn; value = the value being affirmed (or null if unclear).
- corrected: the speaker replaces an earlier value with a new one.
- denied: the speaker says an earlier value is wrong without giving a new one (value null).
- question: the speaker asks for a field without proposing a value (value null).
quote: the shortest exact span of the NEW TURN (verbatim, same casing) that carries the event.
turn_id: the id of the NEW TURN the event comes from.`;

/**
 * v1 (naive, §6.4): values only, no ack/readback/correction semantics. Same output format; the model is told to
 * use kind "stated" for every value, so the v1 status rule ("any stated value = VERIFIED") has nothing else to read.
 */
export const EXTRACTOR_PROMPT_V1 = `You extract facts for an insurance policy-change case from a phone call between an agency REP and a policyholder CUSTOMER.
Intent: add a driver to a personal auto policy. Emit one event for every field value mentioned in the NEW TURNS, with
kind "stated". Never invent values. If nothing relevant is said, return {"events": [], "no_facts": true}.
Fields: driver_full_name, driver_dob (YYYY-MM-DD), driver_age, driver_relation, license_state (2 letters), license_status,
license_number, incidents_3y, vehicle_assignment (policy vehicle id), operator_type, garaging_zip (5 digits),
effective_date (YYYY-MM-DD, relative to CALL DATE), the four discounts, coverage_change, underwriting_review,
premium_new_monthly_usd, premium_change_monthly_usd, amount_due_today_usd (dollars with cents).
quote: the shortest exact span of the NEW TURN that carries the value. acknowledges_turn_id: null. turn_id: the NEW TURN's id.`;

/** The strict `add_driver_patch` output schema (§5.3), in the `extractStructured` `format` shape. */
export const ADD_DRIVER_PATCH_FORMAT = {
  name: "add_driver_patch",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["events", "no_facts"],
    properties: {
      no_facts: { type: "boolean" },
      events: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["turn_id", "field", "kind", "value", "quote", "acknowledges_turn_id", "confidence"],
          properties: {
            turn_id: { type: "string" },
            field: { type: "string", enum: [...FIELD_IDS] },
            kind: { type: "string", enum: ["stated", "readback", "ack", "corrected", "denied", "question"] },
            value: { type: ["string", "null"] },
            quote: { type: "string" },
            acknowledges_turn_id: { type: ["string", "null"] },
            confidence: { type: "string", enum: ["high", "medium", "low"] },
          },
        },
      },
    },
  } as Record<string, unknown>,
} as const;

/** §5.3 call parameters (the model/effort pair is part of the version pin). */
export const EXTRACTOR_MODEL_ID = "gpt-6-luna";
export const EXTRACTOR_REASONING_EFFORT = "none";

/** `extractorVersion = sha256(EXTRACTOR_PROMPT + schema + model + effort).slice(0, 12)` (§5.3 version pinning). */
export function extractorVersionOf(prompt: string, format: { schema: Record<string, unknown> }, model: string, effort: string): string {
  return sha256Hex(prompt + JSON.stringify(format.schema) + model + effort).slice(0, 12);
}
export const EXTRACTOR_VERSION_V3 = extractorVersionOf(EXTRACTOR_PROMPT_V3, ADD_DRIVER_PATCH_FORMAT, EXTRACTOR_MODEL_ID, EXTRACTOR_REASONING_EFFORT);
export const EXTRACTOR_VERSION_V1 = extractorVersionOf(EXTRACTOR_PROMPT_V1, ADD_DRIVER_PATCH_FORMAT, EXTRACTOR_MODEL_ID, EXTRACTOR_REASONING_EFFORT);

/** §5.3 batching: at most this many NEW TURNS per call; RECENT = the last 6 finals before them. */
export const EXTRACT_MAX_NEW_TURNS = 3;
export const EXTRACT_RECENT_TURNS = 6;

const speaker = (t: Pick<TurnInput, "channel">): "REP" | "CUSTOMER" => (t.channel === "rep" ? "REP" : "CUSTOMER");

/**
 * The user input JSON string (§5.3 "User input"). `case` holds only fields that are not MISSING, plus required
 * MISSING fields as `{value:null,status:"MISSING"}`.
 */
export function buildExtractorInput(i: {
  callDate: string;
  policy: PolicyRecord;
  state: Pick<CaseState, "fields">;
  recent: readonly Pick<TurnInput, "turnId" | "channel" | "text">[];
  newTurns: readonly Pick<TurnInput, "turnId" | "channel" | "text">[];
}): string {
  const weekday = WEEKDAYS[weekdayOf(i.callDate)]!;
  const caseObj: Record<string, { value: string | null; status: string }> = {};
  for (const f of FIELD_IDS) {
    const st = i.state.fields[f];
    if (st && st.status !== "MISSING") caseObj[f] = { value: st.value, status: st.status };
    else if (REQUIRED_SET.has(f)) caseObj[f] = { value: null, status: "MISSING" };
  }
  return JSON.stringify({
    call_date: i.callDate,
    call_weekday: weekday[0]!.toUpperCase() + weekday.slice(1),
    policy: {
      policyholder: `${i.policy.policyholder.firstName} ${i.policy.policyholder.lastName}`,
      vehicles: i.policy.vehicles.map((v) => ({ id: v.id, label: v.label })),
      address_zip: i.policy.address.zip,
      existing_drivers: i.policy.existingDrivers.map((d) => d.name),
    },
    case: caseObj,
    recent_turns: i.recent.slice(-EXTRACT_RECENT_TURNS).map((t) => ({ turn_id: t.turnId, speaker: speaker(t), text: t.text })),
    new_turns: i.newTurns.map((t) => ({ turn_id: t.turnId, speaker: speaker(t), text: t.text })),
  });
}
