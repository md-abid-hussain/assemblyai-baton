/**
 * contracts/v2/blueprint.ts - the Relay Blueprint, `changeover.blueprint/2.0` (PLATFORM §3.2 v2.1, verbatim).
 * WP14a; frozen at C2 (D1 13:00); additive changes only afterwards.
 *
 * The body below is PLATFORM §3.2 copied exactly (only this header comment was added). Helpers that are not in
 * §3.2 (tool names, stage mapping, canned states, stored-account marker) live in ./relay.ts, so this file stays
 * a line-for-line match of the spec's code block.
 */
import { z } from "zod";
import { isSafeRegexSource, isSafeToolPattern } from "./regex";   // pure, same dir, WP14a (below the code block)

export const BLUEPRINT_SCHEMA = "changeover.blueprint/2.0" as const;
export const KERNEL_VERSION = "2.0.0" as const;

/** snake_case ids: fields, stages, values, disclosures, connectors, tables, tools. */
export const IdSchema = z.string().regex(/^[a-z][a-z0-9_]{1,39}$/);
/** Template text (grammar §3.3). Parsed and linted, never evaluated as code. */
export const TemplateSchema = z.string().min(1).max(2400);
/** A JS regex SOURCE in the SAFE GRAMMAR (ReDoS guard, enforced at parse time and again by lint X3):
 *  no backreferences (\1, \k<…>), no lookaround ((?=, (?!, (?<=, (?<!), and `*`, `+`, `{n,}` or `{n,m}` (m > 1) never
 *  apply to a group that contains an alternation or another quantifier; `?` may apply to any group. So (a|a)*, (a+)+
 *  and (a|ab)*c are rejected, while Baton's (an? )?, (?:\.\d+)? and (lives? with (us|me|them)|…) pass. ≤ 200 chars.
 *  Always matched with the "iu" flags through safeTest(): compiled once and cached, input truncated to 1000 chars. */
export const RegexSchema = z.string().min(1).max(200).refine(isSafeRegexSource, { message: "unsafe or invalid regex" });
/** A Voice Agent tool-parameter `pattern` (JSON Schema: NO flags). Same safe grammar; checked with `new RegExp(src)`. */
export const ToolPatternSchema = z.string().min(1).max(200).refine(isSafeToolPattern, { message: "unsafe or invalid pattern" });
export const SecretRefSchema = z.object({ $secret: z.string().regex(/^sec_[a-z0-9]{16}$/) }).strict();
export type SecretRef = z.infer<typeof SecretRefSchema>;

// ---- closed vocabularies ---------------------------------------------------------------------------------
/** The 18 live-verified Voice Agent voices (research/10 §3.3). */
export const VA_VOICES = ["alba", "anna", "charles", "estelle", "eve", "george", "giovanni", "iris", "jane", "jean",
  "juergen", "lola", "mary", "michael", "paul", "rafael", "reid", "vera"] as const;
export const TRANSCRIPTION_MODES = ["min_latency", "balanced", "max_accuracy"] as const;
export const INDUSTRIES = ["insurance", "healthcare", "telecom", "utilities", "financial_services", "retail", "other"] as const;
export const FIELD_TYPES = ["text", "person_name", "date", "number", "integer", "money", "signed_money", "enum", "phone",
  "zip", "state", "boolean", "email", "id_code", "lookup"] as const;
/** Normalizer kinds (code, in src/core/relay/normalizers.ts). "insurance.*" wrap the legacy add-driver functions unchanged. */
export const NORMALIZERS = ["text", "free_text_lower", "person_name", "date", "date_future", "date_of_birth", "integer",
  "number", "money", "signed_money", "enum", "boolean", "us_phone", "us_zip5", "us_state", "email", "id_code", "lookup",
  "insurance.relation", "insurance.license_status", "insurance.vehicle", "insurance.incidents", "insurance.discount",
  "insurance.age"] as const;
/** Formatters usable as `{path|formatter}` and as a field's display kind. */
export const FORMATTERS = ["raw", "title", "first_name", "lower", "spoken_date", "spoken_date_long", "spoken_dob",
  "spoken_zip", "spoken_chars", "spoken_money", "spoken_monthly", "state_name", "state_with_code", "enum_label",
  "enum_word", "lookup_label", "underscore_to_space", "insurance.relation_word", "insurance.relation_display",
  "insurance.license_words", "insurance.license_adjective", "insurance.incidents_display",
  "as_spoken",   // WP14a·2, additive: the words as spoken when known, else the value (legacy "as spoken" displays)
] as const;
export const BUILTIN_VALUES = ["insurance.monthly_premium", "insurance.due_today_prorated"] as const;
export const HAND_BACK_REASONS_V2 = ["advice_requested", "customer_request", "conflict", "customer_declined",
  "out_of_scope", "payment_problem", "other"] as const;   // = contracts/tools.ts HAND_BACK_REASONS

// ---- meta -------------------------------------------------------------------------------------------------
export const MetaSchema = z.object({
  schema: z.literal(BLUEPRINT_SCHEMA),
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{2,47}$/),
  title: z.string().min(3).max(60),
  tagline: z.string().max(140),
  industry: z.enum(INDUSTRIES),
  locale: z.literal("en-US"),
  intent: z.object({
    id: IdSchema,                     // "add_driver": extractor format name `${id}_patch`, the case JSON `intent`
    summary: z.string().max(200),     // "add a driver to a personal auto policy"
    caseNoun: z.string().max(60),     // "insurance policy-change case"
  }),
  roles: z.object({ rep: z.string().max(40), customer: z.string().max(40), org: z.string().max(40) }), // "REP","policyholder","agency"
  origin: z.enum(["seed", "user", "draft", "clone"]),
  sampleOnly: z.literal(true),        // disclosures and business rules are samples, never legal advice (UI banner)
});

// ---- account context (the generalized PolicyRecord) -------------------------------------------------------
export const AccountRecordSchema = z.object({
  customer: z.object({ firstName: z.string().max(40), lastName: z.string().max(40), phoneLast4: z.string().regex(/^\d{4}$/),
    address: z.object({ line1: z.string().max(80), city: z.string().max(40), state: z.string().regex(/^[A-Z]{2}$/),
      zip: z.string().regex(/^\d{5}$/) }).optional() }),   // fictional; prefills Polar's billing address (§6.1). Every gallery sample has one
  org: z.object({ name: z.string().max(80), repFirstName: z.string().max(40) }),
  callDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  facts: z.record(IdSchema, z.string().max(200)),                          // policy_number, address_zip, rating_new_monthly_usd, …
  tables: z.record(IdSchema, z.array(z.record(z.string().max(40), z.string().max(120))).max(50)),   // vehicles, prices, …
});
export type AccountRecord = z.infer<typeof AccountRecordSchema>;

export const TableDefSchema = z.object({
  id: IdSchema, label: z.string().max(60),
  columns: z.array(z.string().regex(/^[a-z][a-z0-9_]{0,39}$/)).min(1).max(8),
  idColumn: z.string(), labelColumn: z.string(),
});
export const ContextSchema = z.object({
  facts: z.array(z.object({ key: IdSchema, label: z.string().max(60) })).max(16),
  tables: z.array(TableDefSchema).max(4),
  samples: z.array(AccountRecordSchema).min(1).max(5),     // fictional accounts for tests and simulated calls
});

// ---- named values (money and dates the playbook speaks) ----------------------------------------------------
export type ValueRef =
  | { kind: "field"; field: string; requireRep: boolean }          // VERIFIED value (from the rep if requireRep)
  | { kind: "fact"; key: string }
  | { kind: "fixed"; value: string }
  | { kind: "lookup"; table: string; keyField: string; column: string }
  | { kind: "builtin"; id: (typeof BUILTIN_VALUES)[number] }
  | { kind: "first_of"; refs: ValueRef[] };
export const ValueRefSchema: z.ZodType<ValueRef> = z.lazy(() => z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("field"), field: IdSchema, requireRep: z.boolean() }),
  z.object({ kind: z.literal("fact"), key: IdSchema }),
  z.object({ kind: z.literal("fixed"), value: z.string().max(60) }),
  z.object({ kind: z.literal("lookup"), table: IdSchema, keyField: IdSchema, column: z.string().max(40) }),
  z.object({ kind: z.literal("builtin"), id: z.enum(BUILTIN_VALUES) }),
  z.object({ kind: z.literal("first_of"), refs: z.array(ValueRefSchema).min(2).max(4) }),
]));
export const NamedValueSchema = z.object({
  id: IdSchema, label: z.string().max(60), type: z.enum(["text", "money", "date", "integer"]), ref: ValueRefSchema,
});

// ---- case fields --------------------------------------------------------------------------------------------
export const EnumValueSchema = z.object({
  value: IdSchema,                                        // normalized value, e.g. "learner_permit"
  label: z.string().max(60),
  synonyms: z.array(RegexSchema).max(12),                 // raw text → value (enum normalizer), checked in order
  word: z.string().max(60).optional(),                    // spoken word ("enum_word"), e.g. "probationary license"
  spokenForms: z.array(z.string().max(60)).max(8),        // QA value-bearing forms
  confirm: TemplateSchema.optional(),                     // per-value confirm phrase override
  confirmIfRaw: z.array(z.object({ pattern: RegexSchema, text: TemplateSchema })).max(3).optional(),
});
export const FieldSchema = z.object({
  id: IdSchema,
  label: z.string().min(1).max(60),
  description: z.string().max(300),                       // extractor field guide line + update_case_field hint
  type: z.enum(FIELD_TYPES),
  normalizer: z.enum(NORMALIZERS),
  enumValues: z.array(EnumValueSchema).max(20).optional(),                   // required iff type = "enum"
  lookup: z.object({ table: IdSchema, matchColumns: z.array(z.string()).min(1).max(4), allowAll: z.boolean() }).optional(),
  required: z.boolean(),
  setBy: z.enum(["rep_only", "ai_allowed", "rep_or_customer"]),   // rep_only: only a REP statement or a server value makes it VERIFIED
  // ai_allowed: either party, and the AI may set it with update_case_field (the tool enum, in field order).
  // rep_or_customer (WP14a·2, additive): either party's statements count, but the AI cannot write it with
  // update_case_field (Baton: age, the start date with its own confirm tool, the discounts and coverage).
  adviceDomain: z.boolean(),                              // a rep decision: the AI never raises or changes it (prompt → decided_by_rep)
  serverResolvable: z.object({ value: IdSchema }).optional(),   // never asked; a named value supplies it (Baton: the premium)
  promptVisibility: z.enum(["always", "when_known", "rep_verified_only"]),
  validation: z.object({
    pattern: RegexSchema.optional(),
    min: z.number().optional(), max: z.number().optional(),
    minDaysFromCall: z.number().int().min(-36500).max(3650).optional(),    // dates: outside → PENDING(out_of_range)
    maxDaysFromCall: z.number().int().min(-36500).max(3650).optional(),
  }),
  examples: z.array(z.string().max(80)).max(4),
  compare: z.enum(["exact", "token_subset"]),             // compatible() / mergeValues() (names: token_subset)
  display: z.enum(FORMATTERS),
  capture: z.object({ priority: z.number().int().min(0).max(99), mode: z.enum(TRANSCRIPTION_MODES), entity: z.boolean() }),
  phrases: z.object({ ask: TemplateSchema, confirm: TemplateSchema }),     // "To finish up, I just need {phrase.ask}."
  qa: z.object({ ask: z.array(RegexSchema).max(6), weak: z.array(RegexSchema).max(4) }),
  confirmTool: z.object({                                  // a dedicated confirm tool for a date field (Baton: confirm_effective_date)
    name: IdSchema, description: z.string().max(400), windowDays: z.number().int().min(1).max(365),
  }).optional(),
  ui: z.object({ group: z.string().max(30).nullable(), hidden: z.boolean() }),
});
export type BlueprintField = z.infer<typeof FieldSchema>;

// ---- listening (Realtime STT, one session per channel) -------------------------------------------------------
export const ListeningSchema = z.object({
  keyterms: z.array(z.string().min(1).max(50)).max(60),           // fixed domain terms (STT_FIXED_KEYTERMS for Baton)
  contextKeyterms: z.array(z.string().regex(/^(customer\.(firstName|lastName|fullName)|org\.(name|repFirstName)|fact\.[a-z0-9_]+|table\.[a-z0-9_]+\.[a-z0-9_]+)$/)).max(16),
  languageCodes: z.union([z.tuple([z.literal("en")]), z.tuple([z.literal("en"), z.literal("hi")])]),  // live-verified only
  scenarioPrompt: z.string().min(40).max(1750),                    // STT `prompt`
  tuning: z.enum(["telephony_8k", "wideband_16k"]),                // telephony_8k = TUNING_8K turn silences
});

// ---- handoff ----------------------------------------------------------------------------------------------------
export const HandoffSchema = z.object({
  allowedWhen: z.object({
    minCallSeconds: z.number().int().min(0).max(600),              // the Pass button is enabled after this
    requireVerified: z.array(IdSchema).max(8),                     // fields that must be VERIFIED before Pass
  }),
  repLine: z.string().min(10).max(200),                            // said by the rep (simulator, labels, video). Baton: the line recorded in s01 (§1.3)
  repLinePatterns: z.array(RegexSchema).max(4),                    // detects the line in rep finals (auto-baton on sims)
  acceptance: z.object({ phrase: z.string().min(2).max(100), patterns: z.array(RegexSchema).max(4) }),
  autoBaton: z.boolean(),                                          // arm at the rep line + acceptance (Watch mode)
  repReturnLine: z.string().max(200),                              // spoken by the AI after hand_back_to_rep
});

// ---- playbook -----------------------------------------------------------------------------------------------------
export const StageKindSchema = z.enum(["confirm", "disclose", "act", "close"]);   // runtime Stage: confirm|disclose|pay|close
export const ExitSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("all_required_verified") }),
  z.object({ kind: z.literal("disclosure_accepted"), disclosure: IdSchema }),
  z.object({ kind: z.literal("connector_succeeded"), connector: IdSchema }),
  z.object({ kind: z.literal("end") }),
]);
export const StageSchema = z.object({
  id: IdSchema, kind: StageKindSchema, label: z.string().max(40),
  goal: TemplateSchema,                               // → {stage.goal} in the prompt (Baton: STAGE_INSTRUCTIONS verbatim)
  tools: z.array(IdSchema).min(2).max(6),             // ORDERED; must include update_case_field and hand_back_to_rep
  exit: ExitSchema,
});
export const DisclosureSchema = z.object({
  id: IdSchema, title: z.string().max(60),
  text: TemplateSchema,                               // read verbatim; placeholders resolved server-side at get_disclosure
  criticalTokens: z.array(TemplateSchema).max(8),     // rendered; empty renders dropped
  requiresReady: z.boolean(),                         // refused until every required field is VERIFIED
  requiresAccepted: IdSchema.nullable(),              // refused until that disclosure was accepted (Baton: esign after premium)
  consent: z.boolean(),                               // a yes to this disclosure is consent for the act stage
});
export const GreetingSchema = z.object({
  opening: TemplateSchema,                            // must pass compliance (§3.4 C1): AI assistant, not a person, recorded
  summary: TemplateSchema,                            // may embed {clause.<id>}; field vars only inside verified sections
  clauses: z.array(z.object({ id: IdSchema, text: TemplateSchema, dropOrder: z.number().int().min(0).max(9).nullable() })).max(6),
  optOut: TemplateSchema,
  next: z.object({ confirm: TemplateSchema, ask: TemplateSchema, ready: TemplateSchema }),
  maxWords: z.number().int().min(20).max(40),        // lint G2: the rendered greeting (after drops) must fit; ≈0.34 s/word → ≤ 14 s
});
export const PlaybookSchema = z.object({
  voice: z.enum(VA_VOICES),
  persona: z.object({ tone: z.string().max(200), extraRules: z.array(z.string().max(300)).max(10) }),
  subject: TemplateSchema,                            // {subject}: Baton "{?f.driver_full_name.verified}{f.driver_full_name|first_name}{:}the new driver{/?}"
  greeting: GreetingSchema,
  promptTemplate: TemplateSchema.nullable(),          // null → generated (§4.4); Baton: PROMPT_V3 in v2 placeholders
  caseJson: z.object({
    header: z.array(z.object({ key: z.string().regex(/^[a-z][a-z0-9_]{0,29}$/), from: z.string() })).max(4),       // Baton: [{key:"policy",from:"fact.policy_number"}]
    tables: z.array(z.object({ key: z.string().regex(/^[a-z][a-z0-9_]{0,29}$/), table: IdSchema })).max(2),        // Baton: [{key:"vehicles",table:"vehicles"}] → {id: label}
    maxChars: z.number().int().min(600).max(2400),    // Baton 1800
  }),
  vaKeyterms: z.array(z.string()).max(16),            // paths (as in listening.contextKeyterms) + field refs "f.<id>"
  stages: z.array(StageSchema).min(1).max(4),
  disclosures: z.array(DisclosureSchema).max(4),
  builtinToolText: z.object({                         // defaults = today's Baton texts (§4.5); override per relay
    updateCaseFieldValueHint: z.string().max(300).nullable(),
  }),
  sessionCap: z.object({ baseSec: z.number().int().min(60).max(300), perFieldSec: z.number().int().min(0).max(60), maxSec: z.number().int().min(120).max(420) }),
});

// ---- connectors -----------------------------------------------------------------------------------------------------
/** Tool parameter schema: flat, and only the keywords the Voice Agent accepts (research/10 §3.5, DESIGN §5.8). */
export const ToolParamSchema = z.object({
  type: z.enum(["string", "number", "integer", "boolean"]),
  description: z.string().max(200).optional(),
  enum: z.array(z.string().max(60)).max(20).optional(),
  pattern: ToolPatternSchema.optional(),
  examples: z.array(z.string().max(60)).max(3).optional(),
}).strict();
export const ToolParamsSchema = z.object({
  type: z.literal("object"),
  required: z.array(IdSchema).max(8),
  properties: z.record(IdSchema, ToolParamSchema),
}).strict();
const ConnectorBase = { id: IdSchema, label: z.string().max(60) };
const ToolBase = { toolName: IdSchema, description: z.string().min(10).max(400) };
export const ConnectorSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("payment_link"), ...ConnectorBase, ...ToolBase,
    provider: z.enum(["polar_sandbox", "mock"]), amount: IdSchema /* a named value, money */, esign: z.boolean(),
    smsTemplate: TemplateSchema, requiresDisclosure: IdSchema.nullable() }),
  z.object({ type: z.literal("esign_mock"), ...ConnectorBase, ...ToolBase,
    documentTitle: TemplateSchema, smsTemplate: TemplateSchema, requiresDisclosure: IdSchema.nullable() }),
  z.object({ type: z.literal("sms_mock"), ...ConnectorBase, ...ToolBase, template: TemplateSchema, params: ToolParamsSchema }),
  z.object({ type: z.literal("http_action"), ...ConnectorBase, ...ToolBase,
    method: z.enum(["POST", "GET"]), url: z.string().url().max(300).startsWith("https://"),
    params: ToolParamsSchema,
    headers: z.array(z.object({ name: z.string().regex(/^[A-Za-z0-9-]{1,40}$/),
      value: z.union([z.string().max(200), SecretRefSchema, z.null()]) })).max(4),   // null = a secret dropped by cloning; lint K2 requires it set
    hmacSecret: SecretRefSchema.nullable(),
    timeoutMs: z.number().int().min(500).max(5000),
    responsePick: z.array(z.string().regex(/^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+){0,3}$/)).max(8),   // only these reach the agent
    sideEffect: z.boolean() }),                         // true → only allowed in act/close stages (lint)
  z.object({ type: z.literal("lookup_table"), ...ConnectorBase, ...ToolBase,
    table: IdSchema, keyColumn: z.string(), format: z.enum(["csv", "json"]), data: z.string().max(32_768) }),
  z.object({ type: z.literal("completion_webhook"), ...ConnectorBase,
    url: z.string().url().max(300).startsWith("https://"), hmacSecret: SecretRefSchema.nullable(),   // null after cloning; lint K2
    include: z.array(z.enum(["case", "qa", "payment"])).min(1) }),
  z.object({ type: z.literal("confirmation"), ...ConnectorBase, ...ToolBase,
    requires: z.array(IdSchema).max(3), smsTemplate: TemplateSchema }),     // requires = connectors that must have succeeded
]);
export type Connector = z.infer<typeof ConnectorSchema>;

// ---- QA, extraction, compliance ----------------------------------------------------------------------------------------
export const QaSchema = z.object({
  reaskTargets: z.array(IdSchema).max(24),                // [] = every field with qa.ask patterns
  verbatimThreshold: z.number().min(0.8).max(1),          // Baton 0.90
  adviceLexicon: z.array(RegexSchema).max(6),
});
export const ExtractionSchema = z.object({
  domainLine: z.string().max(300),                        // first line of the extractor prompt
  intentLine: z.string().max(300),
  fieldGuide: z.string().max(4000).nullable(),            // null → generated from fields; Baton: the verbatim V3 block
  contextKey: z.string().regex(/^[a-z][a-z0-9_]{0,29}$/), // "policy"
  context: z.array(z.object({ key: z.string().regex(/^[a-z][a-z0-9_]{0,29}$/), from: z.string() })).max(6),  // ordered
});
export const ComplianceSchema = z.object({
  aiDisclosurePatterns: z.array(RegexSchema).min(2).max(4),   // must match the rendered greeting (Baton: AI assistant, not a person)
  recordingNoticePattern: RegexSchema,                        // "recorded"
  neverCollect: z.array(z.enum(["card_number", "bank_account", "password", "ssn"])).min(3),
});

export const BlueprintSchema = z.object({
  meta: MetaSchema,
  context: ContextSchema,
  fields: z.array(FieldSchema).min(1).max(24),
  values: z.array(NamedValueSchema).max(8),
  listening: ListeningSchema,
  handoff: HandoffSchema,
  playbook: PlaybookSchema,
  connectors: z.array(ConnectorSchema).max(6),
  qa: QaSchema,
  extraction: ExtractionSchema,
  compliance: ComplianceSchema,
});
export type Blueprint = z.infer<typeof BlueprintSchema>;
