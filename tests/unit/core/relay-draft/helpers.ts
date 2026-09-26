/**
 * Fixtures for the drafting tests: a realistic `draft_blueprint` (what luna returns for a dental deposit desk) and
 * the `DeskInput` that produced it. Everything is fictional, as a drafted relay must be.
 */
import type { DeskInput } from "@/core/contracts/v2";
import type { DraftBlueprint } from "@/core/relay/draft/schema";

export const DESK_INPUT: DeskInput = {
  industry: "healthcare",
  businessName: "Riverbend Dental",
  repHandles:
    "The coordinator takes the patient's name, the treatment they are booking and the day they want, then checks the slot is free.",
  aiFinishes: ["confirm_details", "read_disclosure", "take_payment", "send_confirmation"],
  verbatim: "The deposit is non-refundable within 24 hours of the appointment.",
  payment: "A flat 50 dollar deposit",
  tone: "warm, brief, never pushy",
  voice: "alba",
};

/** A well-formed draft: the happy path the pipeline takes with no repair round. */
export function draftFixture(over: Partial<DraftBlueprint> = {}): DraftBlueprint {
  return {
    meta: {
      slug: "riverbend-deposit",
      title: "Dental deposit booking",
      tagline: "The coordinator books it; the assistant takes the deposit.",
      industry: "healthcare",
      caseNoun: "deposit booking",
      intentSummary: "book an appointment and take the deposit that holds it",
      roleRep: "coordinator",
      roleCustomer: "patient",
      roleOrg: "practice",
    },
    sample: {
      businessName: "Riverbend Dental",
      repFirstName: "Dana",
      customerFirstName: "Maya",
      customerLastName: "Ortiz",
      facts: [
        { key: "appointment_date", value: "2026-10-06" },
        { key: "practice_phone", value: "555-0148" },
      ],
    },
    fields: [
      { id: "patient_full_name", label: "Patient name", description: "The patient's full name, as the coordinator took it.", type: "person_name", required: true, setBy: "rep_or_customer", adviceDomain: false, example: "Maya Ortiz", enumValues: [] },
      { id: "procedure", label: "Procedure", description: "What the appointment is for.", type: "enum", required: true, setBy: "rep_only", adviceDomain: true, example: "cleaning", enumValues: [{ value: "cleaning", label: "cleaning" }, { value: "filling", label: "filling" }] },
      { id: "appointment_date", label: "Appointment date", description: "The day the patient is booked for.", type: "date", required: true, setBy: "rep_or_customer", adviceDomain: false, example: "2026-10-06", enumValues: [] },
      { id: "insurance_carrier", label: "Insurance carrier", description: "The dental plan the patient is covered by.", type: "text", required: true, setBy: "ai_allowed", adviceDomain: false, example: "a dental plan", enumValues: [] },
    ],
    values: [{ id: "deposit_amount", label: "Deposit", type: "money", value: "50.00" }],
    handoff: {
      repLine: "I'll pass you to our assistant to take the deposit and text you the confirmation.",
      acceptancePhrase: "Sure, go ahead.",
      repReturnLine: "I'm handing you back to the team now.",
    },
    stages: [
      { id: "confirm_details", kind: "confirm", label: "Confirm", goal: "Confirm the booking details with the patient and get the insurance carrier.", useConnectors: [] },
      { id: "read_terms", kind: "disclose", label: "Disclose", goal: "Read the deposit terms word for word and get a yes.", useConnectors: [] },
      { id: "take_deposit", kind: "act", label: "Deposit", goal: "Send the deposit link and confirm the payment went through.", useConnectors: ["send_deposit_link"] },
      { id: "wrap_up", kind: "close", label: "Close", goal: "Send the confirmation and close warmly.", useConnectors: ["send_confirmation"] },
    ],
    disclosures: [
      {
        id: "deposit_terms",
        title: "Deposit terms",
        text: "The deposit is fifty dollars and it is non-refundable within twenty-four hours of your appointment. Is that okay?",
        criticalTokens: ["non-refundable within twenty-four hours"],
      },
    ],
    connectors: [
      { id: "deposit_link", type: "payment_link", label: "Deposit link", toolName: "send_deposit_link", description: "Texts the patient a secure link to pay the deposit that holds the appointment.", amountValue: "deposit_amount", smsText: "Here's your deposit link: {link}", documentTitle: null },
      { id: "booking_confirmation", type: "confirmation", label: "Booking confirmation", toolName: "send_confirmation", description: "Texts the patient the final booking summary once the deposit is paid.", amountValue: null, smsText: "You're booked. We've texted the details.", documentTitle: null },
    ],
    persona: { tone: "warm, brief, never pushy", voice: "alba" },
    notes: ["I assumed the deposit is fifty dollars.", "I assumed the coordinator already checked the slot is free."],
    ...over,
  };
}
