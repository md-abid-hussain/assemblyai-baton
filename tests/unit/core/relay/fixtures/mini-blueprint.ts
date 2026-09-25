/**
 * A small, lint-clean relay blueprint ("Mini dental deposit") used by the contracts, template and lint tests.
 * Fictional business and people. Every call returns a fresh deep copy, so tests may mutate it.
 */
import type { Blueprint } from "@/core/contracts/v2";

const MINI: Blueprint = {
  meta: {
    schema: "changeover.blueprint/2.0", slug: "mini-dental", title: "Mini dental deposit",
    tagline: "The front desk books; the AI takes the deposit.", industry: "healthcare", locale: "en-US",
    intent: { id: "book_deposit", summary: "take a booking deposit for a dental appointment", caseNoun: "dental booking case" },
    roles: { rep: "front desk", customer: "patient", org: "clinic" }, origin: "seed", sampleOnly: true,
  },
  context: {
    facts: [{ key: "clinic_phone", label: "Clinic phone" }],
    tables: [{ id: "treatments", label: "Treatments", columns: ["id", "label", "deposit_usd"], idColumn: "id", labelColumn: "label" }],
    samples: [{
      customer: {
        firstName: "Maya", lastName: "Ortiz", phoneLast4: "4821",
        address: { line1: "12 Elm St", city: "Springfield", state: "IL", zip: "62701" },
      },
      org: { name: "Brightwater Dental", repFirstName: "Sam" },
      callDate: "2026-09-25",
      facts: { clinic_phone: "555-0100" },
      tables: { treatments: [{ id: "cleaning", label: "Cleaning", deposit_usd: "50.00" }, { id: "whitening", label: "Whitening", deposit_usd: "75.00" }] },
    }],
  },
  fields: [
    {
      id: "patient_name", label: "Patient name", description: "The patient's full name.", type: "person_name",
      normalizer: "person_name", required: true, setBy: "ai_allowed", adviceDomain: false, promptVisibility: "always",
      validation: {}, examples: ["Maya Ortiz"], compare: "token_subset", display: "title",
      capture: { priority: 1, mode: "balanced", entity: true },
      phrases: { ask: "the patient's full name", confirm: "the appointment is for {f.patient_name.display}" },
      qa: { ask: ["\\b(full name|patient'?s name)\\b"], weak: ["\\bname\\b"] },
      ui: { group: null, hidden: false },
    },
    {
      id: "appointment_date", label: "Appointment date", description: "The appointment date.", type: "date",
      normalizer: "date_future", required: true, setBy: "ai_allowed", adviceDomain: false, promptVisibility: "always",
      validation: { minDaysFromCall: 0, maxDaysFromCall: 90 }, examples: ["2026-10-02"], compare: "exact",
      display: "spoken_date", capture: { priority: 2, mode: "balanced", entity: false },
      phrases: { ask: "the appointment date", confirm: "the appointment is on {f.appointment_date|spoken_date}" },
      qa: { ask: ["\\b(what date|which day|when)\\b"], weak: [] },
      confirmTool: { name: "confirm_appointment_date", description: "Confirm the appointment date the patient says.", windowDays: 30 },
      ui: { group: null, hidden: false },
    },
    {
      id: "treatment", label: "Treatment", description: "The booked treatment.", type: "lookup", normalizer: "lookup",
      lookup: { table: "treatments", matchColumns: ["label"], allowAll: false }, required: true, setBy: "rep_only",
      adviceDomain: false, promptVisibility: "always", validation: {}, examples: ["Cleaning"], compare: "exact",
      display: "lookup_label", capture: { priority: 3, mode: "balanced", entity: false },
      phrases: { ask: "the treatment", confirm: "the treatment is {f.treatment.display}" },
      qa: { ask: ["\\btreatment\\b"], weak: [] }, ui: { group: "Booking", hidden: false },
    },
    {
      id: "visit_kind", label: "Visit kind", description: "New or returning patient.", type: "enum", normalizer: "enum",
      enumValues: [
        { value: "new_patient", label: "New patient", synonyms: ["\\bnew\\b", "first (time|visit)"], spokenForms: ["new patient"] },
        { value: "returning", label: "Returning", synonyms: ["\\b(returning|been (here|in) before)\\b"], spokenForms: ["returning"] },
      ],
      required: false, setBy: "ai_allowed", adviceDomain: false, promptVisibility: "when_known", validation: {}, examples: [],
      compare: "exact", display: "enum_label", capture: { priority: 4, mode: "balanced", entity: false },
      phrases: { ask: "whether this is your first visit", confirm: "this is a {f.visit_kind|enum_word} visit" },
      qa: { ask: ["\\b(first visit|been here before)\\b"], weak: [] }, ui: { group: null, hidden: false },
    },
  ],
  values: [
    { id: "deposit", label: "Deposit", type: "money", ref: { kind: "lookup", table: "treatments", keyField: "treatment", column: "deposit_usd" } },
  ],
  listening: {
    keyterms: ["deposit", "cleaning", "whitening"], contextKeyterms: ["customer.fullName", "org.name", "table.treatments.label"],
    languageCodes: ["en"], scenarioPrompt: "A dental front desk call that books a cleaning and takes a deposit by text link.",
    tuning: "telephony_8k",
  },
  handoff: {
    allowedWhen: { minCallSeconds: 20, requireVerified: ["treatment"] },
    repLine: "I'll hand you to our assistant to finish up the deposit.",
    repLinePatterns: ["hand you (over )?to our assistant"],
    acceptance: { phrase: "Sure, thanks.", patterns: ["\\b(sure|okay|ok|yes)\\b"] },
    autoBaton: true, repReturnLine: "I'm handing you back to Sam now.",
  },
  playbook: {
    voice: "alba",
    persona: { tone: "warm and brief", extraRules: [] },
    subject: "{?f.patient_name.verified}{f.patient_name|first_name}{:}the patient{/?}",
    greeting: {
      opening: "Hi {customer.firstName}, I'm {org.name}'s AI assistant, not a person. This call is recorded.",
      summary: "{?f.treatment.verified}I have the {f.treatment.display} booking for {subject}{/?}{clause.date}.",
      clauses: [{ id: "date", text: "{?f.appointment_date.verified} on {f.appointment_date|spoken_date}{/?}", dropOrder: 0 }],
      optOut: "Say Sam anytime to go back.",
      next: { confirm: "Can you confirm {phrase.confirm}?", ask: "To finish up, I just need {phrase.ask}.", ready: "Shall I text you the deposit link?" },
      maxWords: 40,
    },
    promptTemplate: null,
    caseJson: { header: [{ key: "clinic", from: "org.name" }], tables: [{ key: "treatments", table: "treatments" }], maxChars: 1800 },
    vaKeyterms: ["customer.fullName", "f.patient_name"],
    stages: [
      { id: "confirm_details", kind: "confirm", label: "Confirm", goal: "Confirm the booking details with {subject}.",
        tools: ["update_case_field", "confirm_appointment_date", "hand_back_to_rep"], exit: { kind: "all_required_verified" } },
      { id: "disclose_deposit", kind: "disclose", label: "Disclose", goal: "Read the deposit terms verbatim.",
        tools: ["get_disclosure", "update_case_field", "hand_back_to_rep"], exit: { kind: "disclosure_accepted", disclosure: "deposit_terms" } },
      { id: "take_deposit", kind: "act", label: "Deposit", goal: "Text the deposit link and wait.",
        tools: ["send_deposit_link", "update_case_field", "hand_back_to_rep"], exit: { kind: "connector_succeeded", connector: "deposit_link" } },
      { id: "wrap_up", kind: "close", label: "Close", goal: "Send the confirmation and close warmly.",
        tools: ["send_confirmation", "update_case_field", "hand_back_to_rep"], exit: { kind: "end" } },
    ],
    disclosures: [{
      id: "deposit_terms", title: "Deposit terms",
      text: "A deposit of {v.deposit|spoken_money} holds your appointment{?f.appointment_date.verified} on {f.appointment_date|spoken_date}{/?}. It is refundable up to 24 hours before. Is that OK?",
      criticalTokens: ["{v.deposit|spoken_money}", "24 hours"], requiresReady: true, requiresAccepted: null, consent: true,
    }],
    builtinToolText: { updateCaseFieldValueHint: null },
    sessionCap: { baseSec: 120, perFieldSec: 15, maxSec: 180 },
  },
  connectors: [
    { type: "payment_link", id: "deposit_link", label: "Deposit link", toolName: "send_deposit_link",
      description: "Text the patient a secure deposit link.", provider: "mock", amount: "deposit", esign: false,
      smsTemplate: "{org.name}: pay your {v.deposit|spoken_money} deposit here.", requiresDisclosure: "deposit_terms" },
    { type: "confirmation", id: "booking_confirmation", label: "Confirmation", toolName: "send_confirmation",
      description: "Send the booking confirmation text.", requires: ["deposit_link"], smsTemplate: "{org.name}: you're booked, {customer.firstName}." },
    { type: "http_action", id: "crm_note", label: "CRM note", toolName: "log_crm_note", description: "Log a note in the practice CRM.",
      method: "POST", url: "https://postman-echo.com/post",
      params: { type: "object", required: ["note"], properties: { note: { type: "string", description: "One-line note." },
        ref_code: { type: "string", pattern: "^[A-Z]{2}-\\d{4}$" } } },
      headers: [{ name: "Authorization", value: null }], hmacSecret: null, timeoutMs: 3000, responsePick: ["json.note"], sideEffect: false },
  ],
  qa: { reaskTargets: [], verbatimThreshold: 0.9, adviceLexicon: ["\\b(recommend\\w*|you should)\\b"] },
  extraction: {
    domainLine: "a dental clinic booking", intentLine: "book an appointment and take a deposit", fieldGuide: null,
    contextKey: "account", context: [{ key: "clinic", from: "org.name" }, { key: "phone", from: "fact.clinic_phone" }],
  },
  compliance: {
    aiDisclosurePatterns: ["AI assistant", "not a person"], recordingNoticePattern: "recorded",
    neverCollect: ["card_number", "bank_account", "password", "ssn"],
  },
};

export const miniBlueprint = (): Blueprint => structuredClone(MINI);
