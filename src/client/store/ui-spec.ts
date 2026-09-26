/**
 * client/store/ui-spec.ts - the console's view of a relay (PLATFORM §7.6).
 *
 * Everything relay-shaped the console renders — the case card's labels, groups and required set, the stage strip's
 * labels, the QA card's disclosure titles and the phone's payment / e-sign steps — comes from one `UiSpec`
 * (`CreateCaseResponseV2.relay`). When no server spec is present (a fixture log, a recorded bundle, a server that
 * predates v2) the console falls back to `BATON_UI_SPEC`, which is the flagship's own spec written out by hand, so
 * the Baton pages render exactly as they did before this file existed.
 *
 * `tests/unit/ui/ui-spec.test.ts` pins `BATON_UI_SPEC` against `compileRelay(data/relays/baton-add-driver.json).ui`,
 * so the fallback can never drift from what the server sends for the same relay.
 *
 * Pure: no React, no DOM, no store.
 */
import "client-only";

import type { UiSpec } from "@/core/contracts/v2/relay";
// P§4.7 widening: `FieldId` (contracts/case) is now any relay field id, and the flagship's closed enum is
// `BatonFieldId`. These two tables are the flagship's own, so they key on the closed enum.
import { FIELD_IDS, FIELD_LABEL, REQUIRED_FIELDS, type BatonFieldId } from "@/core/intents/add-driver.fields";

/** The case-card group of every Baton field, in `data/relays/baton-add-driver.json` order. */
const BATON_GROUP: Readonly<Record<BatonFieldId, string>> = {
  driver_full_name: "Driver",
  driver_dob: "Driver",
  driver_age: "Driver",
  driver_relation: "Driver",
  license_state: "License",
  license_status: "License",
  license_number: "License",
  incidents_3y: "Driver",
  vehicle_assignment: "Vehicle",
  operator_type: "Vehicle",
  garaging_zip: "Vehicle",
  effective_date: "Change",
  good_student_discount: "Rep decisions",
  driver_training_discount: "Rep decisions",
  distant_student_discount: "Rep decisions",
  mature_driver_discount: "Rep decisions",
  coverage_change: "Rep decisions",
  underwriting_review: "Rep decisions",
  premium_new_monthly_usd: "Price",
  premium_change_monthly_usd: "Price",
  amount_due_today_usd: "Price",
};

const BATON_TYPE: Readonly<Record<BatonFieldId, string>> = {
  driver_full_name: "person_name",
  driver_dob: "date",
  driver_age: "integer",
  driver_relation: "enum",
  license_state: "state",
  license_status: "enum",
  license_number: "id_code",
  incidents_3y: "text",
  vehicle_assignment: "lookup",
  operator_type: "enum",
  garaging_zip: "zip",
  effective_date: "date",
  good_student_discount: "enum",
  driver_training_discount: "enum",
  distant_student_discount: "enum",
  mature_driver_discount: "enum",
  coverage_change: "text",
  underwriting_review: "boolean",
  premium_new_monthly_usd: "money",
  premium_change_monthly_usd: "signed_money",
  amount_due_today_usd: "money",
};

/** Fields only the rep sets (blueprint `setBy: "rep_only"`): the AI never writes them. */
const BATON_REP_ONLY: ReadonlySet<string> = new Set<string>([
  "underwriting_review", "premium_new_monthly_usd", "premium_change_monthly_usd", "amount_due_today_usd",
]);

const required: ReadonlySet<string> = new Set<string>(REQUIRED_FIELDS);

/** The flagship's `UiSpec`: what the server sends for a Baton run, and the console's fallback without one. */
export const BATON_UI_SPEC: UiSpec = {
  relay: { id: null, versionId: null, slug: "baton-add-driver", title: "Baton · add a driver", flagship: true, simulated: false },
  fields: FIELD_IDS.map((id) => ({
    id,
    label: FIELD_LABEL[id],
    required: required.has(id),
    group: BATON_GROUP[id],
    hidden: false,
    type: BATON_TYPE[id],
    repOnly: BATON_REP_ONLY.has(id),
    advice: false,
  })),
  stages: [
    { kind: "confirm", label: "Confirm" },
    { kind: "disclose", label: "Disclose" },
    { kind: "pay", label: "Pay" },
    { kind: "close", label: "Close" },
  ],
  disclosures: [
    { id: "premium_change", title: "Premium change" },
    { id: "esign_consent", title: "E-sign consent" },
  ],
  connectors: [
    { id: "esign_pay", type: "payment_link", label: "E-sign and pay link" },
    { id: "confirmation", type: "confirmation", label: "Confirmation" },
  ],
  phone: { payment: true, esign: true, smsSender: "Harborview Insurance Agency" },
};

export type UiField = UiSpec["fields"][number];

/** The relay spec of a run: the server's, or the flagship fallback. */
export const specOf = (s: { relay: UiSpec | null }): UiSpec => s.relay ?? BATON_UI_SPEC;

/** A label lookup that never throws: an id the spec does not know renders as itself, prettified. */
export function labelsOf(spec: UiSpec): (id: string) => string {
  const map = new Map(spec.fields.map((f) => [f.id, f.label]));
  return (id) => map.get(id) ?? id.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
}

/** The required field ids, in spec order (the readiness gauge's segments). */
export const requiredOf = (spec: UiSpec): string[] => spec.fields.filter((f) => f.required && !f.hidden).map((f) => f.id);

/** Case-card groups in spec order, each with its (visible) field ids. */
export function groupsOf(spec: UiSpec): { group: string | null; ids: string[] }[] {
  const out: { group: string | null; ids: string[] }[] = [];
  for (const f of spec.fields) {
    if (f.hidden) continue;
    const g = f.group ?? null;
    const last = out.find((x) => x.group === g);
    if (last) last.ids.push(f.id);
    else out.push({ group: g, ids: [f.id] });
  }
  return out;
}

/**
 * The case card's heading: the part of the relay title after the brand ("Baton · add a driver" → "Add a driver",
 * "Dental · booking deposit" → "Booking deposit"). A title with no separator is used as it is.
 */
export function caseTitleOf(spec: UiSpec): string {
  const tail = spec.relay.title.split("·").pop()?.trim() ?? spec.relay.title;
  return tail.charAt(0).toUpperCase() + tail.slice(1);
}

/**
 * What to call the AI in a sentence. **"Baton" is the flagship relay, never the product** (PLATFORM §2 glossary), so
 * only the flagship's console may say "Baton is listening"; every other relay's says "The relay agent is listening".
 * "Pass the baton" is the universal action and stays as it is in every relay.
 */
export const agentNameOf = (spec: UiSpec): string => (spec.relay.flagship ? "Baton" : "The relay agent");

/**
 * The phone steps this relay's customer actually takes (`UiSpec.phone`): the paying copy must not promise an e-sign
 * a relay does not have. `verb` is the imperative ("sign and pay"), `verbs` the third person ("signs and pays").
 */
export function paySteps(spec: UiSpec): { esign: boolean; payment: boolean; verb: string; verbs: string } {
  const { esign, payment } = spec.phone;
  if (esign && payment) return { esign, payment, verb: "sign and pay", verbs: "signs and pays" };
  if (esign) return { esign, payment, verb: "sign", verbs: "signs" };
  return { esign, payment, verb: "pay", verbs: "pays" };
}

/** "Relay: <title> v<n>" (PLATFORM §7.6). `versionId` is opaque, so the chip shows its short form. */
export function relayChip(spec: UiSpec): { title: string; version: string | null; flagship: boolean } {
  const v = spec.relay.versionId;
  return { title: spec.relay.title, version: v ? shortVersion(v) : null, flagship: spec.relay.flagship };
}

const shortVersion = (versionId: string): string => {
  const n = /(?:^|[_v-])(\d+)$/.exec(versionId)?.[1];
  return n ? `v${n}` : versionId.replace(/^rv_/, "").slice(0, 6);
};
