/**
 * core/relay/draft/schema.ts - the `draft_blueprint` strict json_schema and its zod twin (PLATFORM §7.4 step 2;
 * WP17·3).
 *
 * The wizard's one luna call returns ONLY what needs judgment: meta, ≤ 12 fields, the money values, the handoff
 * lines, stages, disclosures, connectors, the persona and one fictional sample. Everything mechanical - normalizers,
 * phrases, QA patterns, the greeting skeleton, the tool lists, keyterms, `sessionCap`, the second sample - is filled
 * deterministically by `expandDraft` (expand.ts), so the model cannot get it wrong and two identical drafts expand
 * identically.
 *
 * Strict-mode shape (checked by `assertStrictSchema`): every object carries `additionalProperties:false` and lists
 * every property in `required`; optional values are `[T,"null"]`; records become arrays of `{key,value}`; every enum
 * stays under `STRICT_ENUM_MAX`. Counts (1-12 fields, ≤ 4 stages, ...) are checked here in zod, not in the schema,
 * because `minItems`/`maxItems` are not part of the supported keyword subset.
 *
 * Isomorphic: the Studio can parse a stored draft with the same zod schema the server validates with.
 */
import { z } from "zod";

import { FIELD_TYPES, IdSchema, INDUSTRIES, VA_VOICES } from "../../contracts/v2/blueprint";

/** Field types a drafted relay may use. `lookup` needs a context table and `signed_money` a legacy normalizer. */
export const DRAFT_FIELD_TYPES = ["text", "person_name", "date", "number", "integer", "money", "enum", "phone",
  "zip", "state", "boolean", "email", "id_code"] as const satisfies readonly (typeof FIELD_TYPES)[number][];
export const DRAFT_SET_BY = ["rep_only", "ai_allowed", "rep_or_customer"] as const;
export const DRAFT_STAGE_KINDS = ["confirm", "disclose", "act", "close"] as const;
/** The connector kinds the wizard may reach for. `http_action` needs a real URL and a secret, so it is never drafted. */
export const DRAFT_CONNECTOR_TYPES = ["payment_link", "esign_mock", "sms_mock", "confirmation"] as const;

export const DRAFT_MAX_FIELDS = 12;
export const DRAFT_MAX_STAGES = 4;
export const DRAFT_MAX_DISCLOSURES = 4;
export const DRAFT_MAX_CONNECTORS = 3;
export const DRAFT_MAX_VALUES = 4;

const short = (max: number) => z.string().min(1).max(max);
const KeyValueSchema = z.object({ key: z.string().min(1).max(40), value: z.string().max(120) });

export const DraftFieldSchema = z.object({
  id: IdSchema,
  label: short(60),
  description: z.string().max(300),
  type: z.enum(DRAFT_FIELD_TYPES),
  required: z.boolean(),
  setBy: z.enum(DRAFT_SET_BY),
  /** A rep decision the AI never raises or changes (PLATFORM §3.2). */
  adviceDomain: z.boolean(),
  example: z.string().max(80).nullable(),
  /** Required iff `type` is "enum": the normalized value plus the word a person says. */
  enumValues: z.array(z.object({ value: IdSchema, label: short(60) })).max(12),
});
export type DraftField = z.infer<typeof DraftFieldSchema>;

/** A constant named value - in practice the deposit or fee a payment link charges. */
export const DraftValueSchema = z.object({
  id: IdSchema,
  label: short(60),
  type: z.enum(["money", "text"]),
  /** "50.00" for money; any short string for text. */
  value: short(40),
});
export type DraftValue = z.infer<typeof DraftValueSchema>;

export const DraftStageSchema = z.object({
  id: IdSchema,
  kind: z.enum(DRAFT_STAGE_KINDS),
  label: short(40),
  goal: short(400),
  /** Connector tool names this stage may call. The built-ins are added by `expandDraft`. */
  useConnectors: z.array(IdSchema).max(DRAFT_MAX_CONNECTORS),
});
export type DraftStage = z.infer<typeof DraftStageSchema>;

export const DraftDisclosureSchema = z.object({
  id: IdSchema,
  title: short(60),
  /** Read word for word. `expandDraft` marks it SAMPLE and makes sure it asks the customer a question. */
  text: short(1200),
  criticalTokens: z.array(short(120)).max(8),
});
export type DraftDisclosure = z.infer<typeof DraftDisclosureSchema>;

export const DraftConnectorSchema = z.object({
  id: IdSchema,
  type: z.enum(DRAFT_CONNECTOR_TYPES),
  label: short(60),
  toolName: IdSchema,
  description: z.string().min(10).max(400),
  /** `payment_link` only: the id of the money value it charges. */
  amountValue: IdSchema.nullable(),
  /** The text message the customer gets. `{link}` is substituted at run time. */
  smsText: z.string().max(400).nullable(),
  /** `esign_mock` only. */
  documentTitle: z.string().max(120).nullable(),
});
export type DraftConnector = z.infer<typeof DraftConnectorSchema>;

export const DraftSampleSchema = z.object({
  businessName: short(60),
  repFirstName: short(40),
  customerFirstName: short(40),
  customerLastName: short(40),
  /** The account facts the greeting and the case card may quote, e.g. `appointment_date`. */
  facts: z.array(KeyValueSchema).max(8),
});

export const DraftMetaSchema = z.object({
  slug: z.string().regex(/^[a-z][a-z0-9-]{1,48}$/),
  title: short(60),
  tagline: z.string().max(120),
  industry: z.enum(INDUSTRIES),
  /** "deposit booking", "plan change": what one of these cases is called. */
  caseNoun: short(40),
  /** One line: what the rep and the AI together finish. */
  intentSummary: short(200),
  roleRep: short(30),
  roleCustomer: short(30),
  roleOrg: short(30),
});

export const DraftHandoffSchema = z.object({
  repLine: z.string().min(10).max(200),
  acceptancePhrase: z.string().min(2).max(100),
  repReturnLine: z.string().max(200),
});

/** The luna output of PLATFORM §7.4 step 2, before `expandDraft`. */
export const DraftBlueprintSchema = z.object({
  meta: DraftMetaSchema,
  sample: DraftSampleSchema,
  fields: z.array(DraftFieldSchema).min(1).max(DRAFT_MAX_FIELDS),
  values: z.array(DraftValueSchema).max(DRAFT_MAX_VALUES),
  handoff: DraftHandoffSchema,
  stages: z.array(DraftStageSchema).min(1).max(DRAFT_MAX_STAGES),
  disclosures: z.array(DraftDisclosureSchema).max(DRAFT_MAX_DISCLOSURES),
  connectors: z.array(DraftConnectorSchema).max(DRAFT_MAX_CONNECTORS),
  persona: z.object({ tone: short(200), voice: z.enum(VA_VOICES) }),
  /** "Assumptions I made: ..." - shown with the created relay and used for the relay-as-code header (SAAS §7). */
  notes: z.array(z.string().max(200)).max(8),
});
export type DraftBlueprint = z.infer<typeof DraftBlueprintSchema>;

// ============================================================================================ the strict schema

type Node = Record<string, unknown>;

const str = (description?: string): Node => (description ? { type: "string", description } : { type: "string" });
const nullableStr = (description: string): Node => ({ type: ["string", "null"], description });
const bool = (description: string): Node => ({ type: "boolean", description });
const enumOf = (values: readonly string[], description: string): Node => ({ type: "string", enum: [...values], description });
const arrayOf = (items: Node, description: string): Node => ({ type: "array", description, items });
const obj = (properties: Record<string, Node>, description?: string): Node => ({
  type: "object",
  ...(description ? { description } : {}),
  additionalProperties: false,
  required: Object.keys(properties),
  properties,
});

const keyValue = (description: string): Node =>
  arrayOf(obj({ key: str(), value: str() }), description);

/**
 * The `draft_blueprint` format for `text.format`. Every description is part of the prompt: the instructions carry
 * the rules, the schema carries what each slot means.
 */
export function draftBlueprintFormat(): { name: string; strict: true; schema: Record<string, unknown> } {
  return {
    name: "draft_blueprint",
    strict: true,
    schema: obj({
      meta: obj({
        slug: str("kebab-case, 2-4 words, e.g. dental-deposit"),
        title: str("the relay's name, e.g. \"Dental deposit booking\""),
        tagline: str("one short line under the title"),
        industry: enumOf(INDUSTRIES, "the closest industry"),
        caseNoun: str("what one of these cases is called, e.g. \"deposit booking\""),
        intentSummary: str("one line: what the rep and the AI together finish"),
        roleRep: str("what the business calls its person, e.g. \"coordinator\""),
        roleCustomer: str("what the business calls the caller, e.g. \"patient\""),
        roleOrg: str("what the business is, e.g. \"practice\""),
      }, "what this relay is and who is on the call"),
      sample: obj({
        businessName: str("a FICTIONAL business name; never a real company"),
        repFirstName: str("the rep's first name"),
        customerFirstName: str("the customer's first name"),
        customerLastName: str("the customer's last name"),
        facts: keyValue("account facts for this one sample, snake_case keys, e.g. appointment_date"),
      }, "one fictional sample account the whole relay is demonstrated with"),
      fields: arrayOf(
        obj({
          id: str("snake_case, e.g. patient_full_name"),
          label: str("the case-card label, e.g. \"Patient name\""),
          description: str("one sentence for the extractor: what this is and where it comes from"),
          type: enumOf(DRAFT_FIELD_TYPES, "the value's shape"),
          required: bool("true when the case is not finished without it"),
          setBy: enumOf(DRAFT_SET_BY, "rep_only = only the rep may set it; ai_allowed = the AI may finish it; rep_or_customer = either party states it but the AI never writes it"),
          adviceDomain: bool("true when this is the rep's judgment call and the AI must never raise or change it"),
          example: nullableStr("one realistic example value, or null"),
          enumValues: arrayOf(obj({ value: str("snake_case"), label: str("the words a person says") }), "the allowed values; EMPTY unless type is enum"),
        }),
        `1-${DRAFT_MAX_FIELDS} case fields, in the order they come up on the call`,
      ),
      values: arrayOf(
        obj({
          id: str("snake_case, e.g. deposit_amount"),
          label: str("what it is called"),
          type: enumOf(["money", "text"], "money uses plain digits, e.g. 50.00"),
          value: str("the fixed amount or text"),
        }),
        "fixed amounts the call refers to (a deposit, a fee). Empty when there is no money.",
      ),
      handoff: obj({
        repLine: str("the sentence the rep says to hand the call over, e.g. \"I'll pass you to our assistant to take the deposit.\""),
        acceptancePhrase: str("the short yes the customer answers with"),
        repReturnLine: str("what the AI says when it hands back to a person"),
      }, "the handover itself: what the rep says, and what the customer answers"),
      stages: arrayOf(
        obj({
          id: str("snake_case"),
          kind: enumOf(DRAFT_STAGE_KINDS, "confirm = settle the details; disclose = read something word for word; act = take a payment or e-sign; close = wrap up. They must appear in that order and never repeat."),
          label: str("2-3 words for the stage strip"),
          goal: str("what the AI must achieve in this stage, addressed to the AI"),
          useConnectors: arrayOf(str(), "the toolName of each connector this stage may call; empty for confirm and close"),
        }),
        `1-${DRAFT_MAX_STAGES} stages, in order, ending with a close stage`,
      ),
      disclosures: arrayOf(
        obj({
          id: str("snake_case"),
          title: str("what it is called"),
          text: str("read word for word; end with a question the customer can answer yes to"),
          criticalTokens: arrayOf(str(), "the phrases inside the text that MUST be said exactly, e.g. the amount"),
        }),
        `0-${DRAFT_MAX_DISCLOSURES} things that must be read word for word. Empty when nothing must be.`,
      ),
      connectors: arrayOf(
        obj({
          id: str("snake_case"),
          type: enumOf(DRAFT_CONNECTOR_TYPES, "payment_link = charge an amount; esign_mock = sign a document; sms_mock = send a text; confirmation = send the final summary"),
          label: str("what it is called"),
          toolName: str("snake_case verb, e.g. send_deposit_link"),
          description: str("one sentence the AI reads to decide when to call it"),
          amountValue: nullableStr("for payment_link: the id of the money value it charges; null otherwise"),
          smsText: nullableStr("the text message the customer gets; use {link} where the link goes; null when it sends nothing"),
          documentTitle: nullableStr("for esign_mock: the document's title; null otherwise"),
        }),
        `0-${DRAFT_MAX_CONNECTORS} connectors. Only add one the desk actually needs.`,
      ),
      persona: obj({
        tone: str("how the assistant sounds, e.g. \"warm, brief, never pushy\""),
        voice: enumOf(VA_VOICES, "the voice to speak in"),
      }, "how the assistant comes across"),
      notes: arrayOf(str(), "\"Assumptions I made\": each one short, plain, and about a choice the person should check"),
    }),
  };
}
