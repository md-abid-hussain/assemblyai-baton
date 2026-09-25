import "server-only";

import { BLUEPRINT_SCHEMA, type Blueprint, type INDUSTRIES } from "../../core/contracts/v2";

type Industry = (typeof INDUSTRIES)[number];

const ORG_OF: Record<Industry, { org: string; name: string; customer: string }> = {
  insurance: { org: "agency", name: "Example Insurance Agency", customer: "policyholder" },
  healthcare: { org: "clinic", name: "Example Clinic", customer: "patient" },
  telecom: { org: "carrier", name: "Example Mobile", customer: "subscriber" },
  utilities: { org: "utility", name: "Example Power & Water", customer: "account holder" },
  financial_services: { org: "bank", name: "Example Credit Union", customer: "member" },
  retail: { org: "store", name: "Example Store", customer: "customer" },
  other: { org: "business", name: "Example Company", customer: "customer" },
};

/**
 * The "Blank relay" starting point (PLATFORM §7.1, `POST /api/relays {kind:"blank"}`): the smallest blueprint that
 * passes `BlueprintSchema`: one field, a confirm and a close stage, no connectors or disclosures, a compliant greeting
 * and one fictional sample account. Lint may still warn; the Studio guides the rest.
 */
export function blankBlueprint(industry: Industry, callDate: string): Blueprint {
  const o = ORG_OF[industry];
  return {
    meta: {
      schema: BLUEPRINT_SCHEMA, slug: "untitled-relay", title: "Untitled relay", tagline: "", industry, locale: "en-US",
      intent: { id: "finish_case", summary: "finish the case the rep started", caseNoun: `${o.org} case` },
      roles: { rep: "rep", customer: o.customer, org: o.org }, origin: "user", sampleOnly: true,
    },
    context: {
      facts: [],
      tables: [],
      samples: [{
        customer: {
          firstName: "Alex", lastName: "Rivera", phoneLast4: "0142",
          address: { line1: "100 Main St", city: "Springfield", state: "IL", zip: "62701" },
        },
        org: { name: o.name, repFirstName: "Sam" },
        callDate,
        facts: {},
        tables: {},
      }],
    },
    fields: [{
      id: "customer_name", label: "Customer name", description: `The ${o.customer}'s full name.`, type: "person_name",
      normalizer: "person_name", required: true, setBy: "ai_allowed", adviceDomain: false, promptVisibility: "always",
      validation: {}, examples: ["Alex Rivera"], compare: "token_subset", display: "title",
      capture: { priority: 1, mode: "balanced", entity: true },
      phrases: { ask: "your full name", confirm: "your name is {f.customer_name.display}" },
      qa: { ask: ["\\b(full name|your name)\\b"], weak: [] },
      ui: { group: null, hidden: false },
    }],
    values: [],
    listening: {
      keyterms: [], contextKeyterms: ["customer.fullName", "org.name"], languageCodes: ["en"],
      scenarioPrompt: `A ${o.org} phone call where a human rep gathers the details, then hands the ${o.customer} to an AI assistant to finish.`,
      tuning: "telephony_8k",
    },
    handoff: {
      allowedWhen: { minCallSeconds: 20, requireVerified: [] },
      repLine: "I'll hand you to our assistant to finish up.",
      repLinePatterns: ["hand you (over )?to our assistant"],
      acceptance: { phrase: "Sure, thanks.", patterns: ["\\b(sure|okay|ok|yes)\\b"] },
      autoBaton: true,
      repReturnLine: "I'm handing you back to the team now.",
    },
    playbook: {
      voice: "alba",
      persona: { tone: "warm and brief", extraRules: [] },
      subject: "{?f.customer_name.verified}{f.customer_name|first_name}{:}you{/?}",
      greeting: {
        opening: "Hi {customer.firstName}, I'm {org.name}'s AI assistant, not a person, and this call is recorded.",
        summary: "I'll finish up from here.",
        clauses: [],
        optOut: "Ask for a person anytime to go back.",
        next: { confirm: "Can you confirm {phrase.confirm}?", ask: "To finish up, I just need {phrase.ask}.", ready: "Is there anything else I can help with?" },
        maxWords: 40,
      },
      promptTemplate: null,
      caseJson: { header: [{ key: "business", from: "org.name" }], tables: [], maxChars: 1200 },
      vaKeyterms: ["customer.fullName"],
      stages: [
        { id: "confirm_details", kind: "confirm", label: "Confirm", goal: "Confirm the case details with {subject}.",
          tools: ["update_case_field", "hand_back_to_rep"], exit: { kind: "all_required_verified" } },
        { id: "wrap_up", kind: "close", label: "Close", goal: "Summarize what was done and close warmly.",
          tools: ["update_case_field", "hand_back_to_rep"], exit: { kind: "end" } },
      ],
      disclosures: [],
      builtinToolText: { updateCaseFieldValueHint: null },
      sessionCap: { baseSec: 120, perFieldSec: 15, maxSec: 180 },
    },
    connectors: [],
    qa: { reaskTargets: [], verbatimThreshold: 0.9, adviceLexicon: ["\\b(recommend\\w*|you should)\\b"] },
    extraction: {
      domainLine: `a ${o.org} customer call`, intentLine: "finish the case the rep started", fieldGuide: null,
      contextKey: "account", context: [{ key: "business", from: "org.name" }],
    },
    compliance: {
      aiDisclosurePatterns: ["AI assistant", "not a person"], recordingNoticePattern: "recorded",
      neverCollect: ["card_number", "bank_account", "password", "ssn"],
    },
  };
}
