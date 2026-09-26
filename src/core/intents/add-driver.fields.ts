/**
 * add-driver.fields.ts - the `add_driver` intent's field registry (WP0a).
 *
 * BatonFieldId === the recording kit's FactField (tools/recording-kit/src/scenarios.ts FACT_FIELDS), copied here
 * so product code never imports the kit. tests/unit/core/fields-parity.test.ts asserts equality of
 * FACT_FIELDS, REQUIRED_FIELDS, RELATIONS, LICENSE_STATUSES, OPERATOR_TYPES, DISCOUNT_VALUES, STATUSES,
 * LANGUAGES and HANDOFF_RESPONSES against the kit, and validates every data/scenarios/sNN.json against them.
 *
 * Pure data: no imports, no side effects. Normalizers, phrases and the lexicon live in add-driver.ts (WP1).
 */

// ------------------------------------------------------------------------------------------ vocabularies (= kit)

/** Every fact field (21), in the kit's order. */
export const FIELD_IDS = [
  "driver_full_name", "driver_dob", "driver_age", "driver_relation",
  "license_state", "license_status", "license_number", "incidents_3y",
  "vehicle_assignment", "operator_type", "garaging_zip", "effective_date",
  "good_student_discount", "driver_training_discount", "distant_student_discount", "mature_driver_discount",
  "coverage_change", "underwriting_review",
  "premium_new_monthly_usd", "premium_change_monthly_usd", "amount_due_today_usd",
] as const;
export type BatonFieldId = (typeof FIELD_IDS)[number];

/** The intent's required slots (kit REQUIRED_FIELDS, 10). `Readiness.requiredTotal` = 10. */
export const REQUIRED_FIELDS = [
  "driver_full_name", "driver_dob", "driver_relation", "license_state", "license_status",
  "vehicle_assignment", "operator_type", "garaging_zip", "effective_date", "premium_new_monthly_usd",
] as const satisfies readonly BatonFieldId[];
export type RequiredField = (typeof REQUIRED_FIELDS)[number];

/** Field statuses (kit STATUSES). */
export const FIELD_STATUSES = ["VERIFIED", "PENDING", "MISSING"] as const;

/** Relationship of the new driver to the policyholder (kit RELATIONS). */
export const RELATIONS = [
  "spouse", "domestic_partner", "child", "stepchild", "parent", "sibling",
  "other_relative", "non_relative_resident", "non_relative_nonresident",
] as const;
export type Relation = (typeof RELATIONS)[number];

export const LICENSE_STATUSES = ["learner_permit", "provisional", "full"] as const;
export type LicenseStatus = (typeof LICENSE_STATUSES)[number];

export const OPERATOR_TYPES = ["primary", "occasional"] as const;
export type OperatorType = (typeof OPERATOR_TYPES)[number];

export const DISCOUNT_VALUES = ["eligible", "not_eligible", "pending_proof"] as const;
export type DiscountValue = (typeof DISCOUNT_VALUES)[number];

/** Scenario languages (kit LANGUAGES). */
export const LANGUAGES = ["en", "hinglish"] as const;
export type Language = (typeof LANGUAGES)[number];

/** How the customer answers the rep's hand-off line (kit HANDOFF_RESPONSES). */
export const HANDOFF_RESPONSES = ["accepts", "accepts_after_question", "declines"] as const;
export type HandoffResponse = (typeof HANDOFF_RESPONSES)[number];

/** 2-letter US state codes incl. DC (kit US_STATES). */
export const US_STATES = [
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "DC", "FL", "GA", "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA",
  "ME", "MD", "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ", "NM", "NY", "NC", "ND", "OH", "OK", "OR",
  "PA", "RI", "SC", "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY",
] as const;
export type UsState = (typeof US_STATES)[number];

// ------------------------------------------------------------------------------------------ product field sets (DESIGN §4.1)

/** If not VERIFIED from the rep, get_disclosure supplies it from the rating tool; never asked by the AI. */
export const SERVER_RESOLVABLE = ["premium_new_monthly_usd"] as const satisfies readonly BatonFieldId[];

/** Only a REP statement (or an AI tool update) can make these VERIFIED. */
export const REP_ONLY = [
  "premium_new_monthly_usd", "premium_change_monthly_usd", "amount_due_today_usd", "underwriting_review",
] as const satisfies readonly BatonFieldId[];

/** The `update_case_field` enum: fields the Voice Agent may set (DESIGN §5.8). */
export const AI_SETTABLE = [
  "driver_full_name", "driver_dob", "driver_relation", "license_state", "license_status",
  "license_number", "incidents_3y", "vehicle_assignment", "operator_type", "garaging_zip",
] as const satisfies readonly BatonFieldId[];
export type AiSettableField = (typeof AI_SETTABLE)[number];

/** The AI never raises or changes these; rep only (they go under `decided_by_rep` in the prompt). */
export const ADVICE_DOMAIN = [
  "coverage_change", "good_student_discount", "driver_training_discount", "distant_student_discount",
  "mature_driver_discount", "underwriting_review",
] as const satisfies readonly BatonFieldId[];

/** Money fields: normalized as dollars with 2 decimals ("142.00", "-12.50"). */
export const MONEY_FIELDS = [
  "premium_new_monthly_usd", "premium_change_monthly_usd", "amount_due_today_usd",
] as const satisfies readonly BatonFieldId[];

export const DISCOUNT_FIELDS = [
  "good_student_discount", "driver_training_discount", "distant_student_discount", "mature_driver_discount",
] as const satisfies readonly BatonFieldId[];

/**
 * P§4.7: the sets and predicates take `string`, because `FieldId` (contracts/case) is now any id and a generic
 * relay's field may be asked about here. Membership is still exactly the Baton vocabulary above.
 */
const setOf = (xs: readonly BatonFieldId[]): ReadonlySet<string> => new Set<string>(xs);
export const REQUIRED_SET: ReadonlySet<string> = setOf(REQUIRED_FIELDS);
export const REP_ONLY_SET: ReadonlySet<string> = setOf(REP_ONLY);
export const AI_SETTABLE_SET: ReadonlySet<string> = setOf(AI_SETTABLE);
export const ADVICE_DOMAIN_SET: ReadonlySet<string> = setOf(ADVICE_DOMAIN);
export const SERVER_RESOLVABLE_SET: ReadonlySet<string> = setOf(SERVER_RESOLVABLE);
export const MONEY_FIELD_SET: ReadonlySet<string> = setOf(MONEY_FIELDS);

export const isFieldId = (x: unknown): x is BatonFieldId => typeof x === "string" && (FIELD_IDS as readonly string[]).includes(x);
export const isRequired = (f: string): boolean => REQUIRED_SET.has(f);
export const isRepOnly = (f: string): boolean => REP_ONLY_SET.has(f);
export const isAiSettable = (f: string): f is AiSettableField => AI_SETTABLE_SET.has(f);
export const isAdviceDomain = (f: string): boolean => ADVICE_DOMAIN_SET.has(f);

// ------------------------------------------------------------------------------------------ value kinds and labels (= kit)

/** The kit's value kind per field (drives normalizer choice and UI formatting). */
export type FieldKind =
  | { t: "string" } | { t: "date" } | { t: "int" } | { t: "state" } | { t: "zip" } | { t: "vehicle" }
  | { t: "money" } | { t: "signed_money" } | { t: "boolean" } | { t: "enum"; values: readonly string[] };

export const FIELD_KIND: Readonly<Record<BatonFieldId, FieldKind>> = {
  driver_full_name: { t: "string" },
  driver_dob: { t: "date" },
  driver_age: { t: "int" },
  driver_relation: { t: "enum", values: RELATIONS },
  license_state: { t: "state" },
  license_status: { t: "enum", values: LICENSE_STATUSES },
  license_number: { t: "string" },
  incidents_3y: { t: "string" },
  vehicle_assignment: { t: "vehicle" },
  operator_type: { t: "enum", values: OPERATOR_TYPES },
  garaging_zip: { t: "zip" },
  effective_date: { t: "date" },
  good_student_discount: { t: "enum", values: DISCOUNT_VALUES },
  driver_training_discount: { t: "enum", values: DISCOUNT_VALUES },
  distant_student_discount: { t: "enum", values: DISCOUNT_VALUES },
  mature_driver_discount: { t: "enum", values: DISCOUNT_VALUES },
  coverage_change: { t: "string" },
  underwriting_review: { t: "boolean" },
  premium_new_monthly_usd: { t: "money" },
  premium_change_monthly_usd: { t: "signed_money" },
  amount_due_today_usd: { t: "money" },
};

/** Human labels (kit FIELD_LABEL) for the case card. */
export const FIELD_LABEL: Readonly<Record<BatonFieldId, string>> = {
  driver_full_name: "New driver's full name",
  driver_dob: "Date of birth",
  driver_age: "Age",
  driver_relation: "Relationship to policyholder",
  license_state: "License state",
  license_status: "License type",
  license_number: "License number",
  incidents_3y: "Tickets / accidents (3 yrs)",
  vehicle_assignment: "Vehicle they'll drive",
  operator_type: "Primary or occasional driver",
  garaging_zip: "Garaging ZIP (where the car is kept)",
  effective_date: "Effective date",
  good_student_discount: "Good-student discount",
  driver_training_discount: "Driver-training discount",
  distant_student_discount: "Distant-student discount",
  mature_driver_discount: "Mature-driver discount",
  coverage_change: "Coverage change",
  underwriting_review: "Underwriting review needed",
  premium_new_monthly_usd: "New monthly premium",
  premium_change_monthly_usd: "Monthly premium change",
  amount_due_today_usd: "Amount due today",
};

/**
 * P§4.7 accessors for the two literal-keyed maps. The maps stay keyed by `BatonFieldId`; these take any id, so a
 * caller holding a widened `FieldId` (a relay's field) needs no cast and gets a sane answer: the id itself as a
 * label, and no legacy value kind.
 */
export const fieldLabelOf = (f: string): string => (isFieldId(f) ? FIELD_LABEL[f] : f);
export const fieldKindOf = (f: string): FieldKind | null => (isFieldId(f) ? FIELD_KIND[f] : null);
