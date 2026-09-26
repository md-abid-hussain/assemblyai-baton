/**
 * devtools/schema-docs.ts - the hand-kept descriptions that turn the generated JSON Schema into IDE help
 * (SAAS §5.4). WP23.
 *
 * zod carries no descriptions for `contracts/v2/blueprint.ts` (it is a verbatim copy of PLATFORM §3.2, whose
 * documentation lives in `//` comments), so the text an author sees on hover in VS Code is kept here instead.
 * Paths are dotted, with `[]` for an array's items and `{}` for a record's values:
 *   "meta.slug"  ·  "fields[].validation.pattern"  ·  "context.samples[].facts{}"
 * A path with no entry simply has no description; nothing breaks, and `npm run devtools:schema` is deterministic
 * either way. `tests/unit/devtools/schema.test.ts` checks that every path listed here still exists in the schema,
 * so a rename in the contracts cannot leave a stale description behind.
 */

/** Appended to every string that is a blueprint REGEX (`RegexSchema`, `ToolPatternSchema`). */
export const REGEX_NOTE =
  "A JavaScript regular expression source in the safe grammar, validated server-side: no backreferences, no lookaround, "
  + "and no nested quantifiers (a `*`, `+` or `{n,}` never applies to a group holding an alternation or another quantifier). "
  + "Matched with the `iu` flags, against at most 1000 characters.";

/** Appended to every `TemplateSchema` string. */
export const TEMPLATE_NOTE =
  "Template text: `{path}`, `{path|formatter}` and `{?cond}…{:}…{/?}` sections are rendered server-side. "
  + "It is parsed and linted, never evaluated as code.";

export const ROOT_TITLE = "Changeover relay blueprint";
export const ROOT_DESCRIPTION =
  "One relay, as code: the case fields, the handoff, the playbook the agent follows and the connectors it may call. "
  + "A file is exactly one blueprint of schema `changeover.blueprint/2.0`, written as YAML 1.2 or JSON, and is "
  + "validated by this schema, then by the relay linter. Secret values never appear in a blueprint: use a "
  + "`{ \"$secret\": \"sec_…\" }` reference.";

export const SCHEMA_KEY_DESCRIPTION =
  "Optional editor hint. It is ignored by validation; in YAML use the header comment "
  + "`# yaml-language-server: $schema=<url>` instead.";

export const SCHEMA_DOCS: Readonly<Record<string, string>> = {
  meta: "Identity and framing: what this relay is, who the parties are and where it came from.",
  "meta.schema": "The blueprint schema marker. Always `changeover.blueprint/2.0`.",
  "meta.slug": "URL-safe id, unique inside the organization: lower-case letters, digits and hyphens.",
  "meta.title": "The relay's display name, shown in the Studio, the gallery and the run header.",
  "meta.tagline": "One sentence for cards and the gallery.",
  "meta.industry": "The industry this relay belongs to; it drives sample wording and gallery filters.",
  "meta.locale": "The only supported locale so far: `en-US`.",
  "meta.intent": "The single intent the relay finishes: its id, a summary line and the noun for the case it builds.",
  "meta.intent.id": "snake_case intent id. The extractor's format is named `<id>_patch` and the case JSON carries it.",
  "meta.roles": "What the three parties are called in prompts and labels: the rep, the customer and the organization.",
  "meta.origin": "Where the blueprint came from: `seed` (shipped), `user`, `draft` or `clone`.",
  "meta.sampleOnly": "Always true: disclosures and business rules in a blueprint are samples, never legal advice.",

  context: "The account context a relay reads: which facts and tables exist, and fictional samples to test with.",
  "context.facts": "The named facts a case may reference as `{fact.<key>}`.",
  "context.tables": "Table definitions (vehicles, prices, …) that lookups and the case JSON may read.",
  "context.samples": "Fictional accounts, used by simulated calls, lint and the test runs. At least one.",
  "context.samples[].facts": "Fact values for this sample account, keyed by the fact ids declared in `context.facts`.",
  "context.samples[].tables": "Table rows for this sample account, keyed by the table ids declared in `context.tables`.",

  fields: "The case fields the relay collects. The order is the order the agent asks in and the order of the tool enum.",
  "fields[].id": "snake_case field id, referenced as `{f.<id>}` in templates.",
  "fields[].label": "Short human label, shown on the case card.",
  "fields[].description": "One line of guidance: it becomes the extractor's field guide line and the tool's value hint.",
  "fields[].type": "The value's kind. It decides the case-card rendering and the default normalizer.",
  "fields[].normalizer": "How raw speech becomes a stored value.",
  "fields[].enumValues": "Required when `type` is `enum`: the closed list of values, their synonyms and spoken forms.",
  "fields[].lookup": "Required when `type` is `lookup`: the table and the columns a spoken answer is matched against.",
  "fields[].required": "Whether the case is incomplete until this field is VERIFIED.",
  "fields[].setBy": "Who may set it: `rep_only`, `ai_allowed` (the agent may write it) or `rep_or_customer`.",
  "fields[].adviceDomain": "True for a rep decision the agent must never raise or change (it is marked decided by the rep).",
  "fields[].serverResolvable": "The named value that supplies this field, so the agent never asks for it.",
  "fields[].promptVisibility": "When the field appears in the prompt: `always`, `when_known` or `rep_verified_only`.",
  "fields[].validation": "Value limits. A value outside them is kept PENDING with a reason rather than dropped.",
  "fields[].validation.minDaysFromCall": "Earliest allowed date, in days from the call date (negative is in the past).",
  "fields[].validation.maxDaysFromCall": "Latest allowed date, in days from the call date.",
  "fields[].examples": "Example values, shown in the Studio and used by the extractor's guide.",
  "fields[].compare": "How two candidate values are compared: `exact`, or `token_subset` for names.",
  "fields[].display": "The formatter used when the value is displayed or spoken.",
  "fields[].capture": "Capture hints: ask priority, the transcription mode to use and whether it is an entity.",
  "fields[].phrases": "What the agent says: the ask and the confirmation for this field.",
  "fields[].qa": "Quality patterns: what counts as having asked for this field, and what counts as a weak ask.",
  "fields[].confirmTool": "An optional dedicated confirmation tool for a date field, with its own window in days.",
  "fields[].ui": "Studio presentation: the group the field sits in, and whether it is hidden.",

  values: "Named values (money, dates) the playbook can speak, resolved from fields, facts, tables or built-ins.",
  "values[].ref": "Where the value comes from. `first_of` tries its refs in order and takes the first that resolves.",

  listening: "Live transcription settings for the call: key terms, languages, the scenario prompt and the tuning.",
  "listening.keyterms": "Fixed domain terms that help transcription (product names, jargon).",
  "listening.contextKeyterms": "Paths whose values are added as key terms at run time, e.g. `customer.lastName`.",
  "listening.languageCodes": "The languages to transcribe: `[en]`, or `[en, hi]` for a bilingual call.",
  "listening.scenarioPrompt": "The transcription prompt: what this call is about, in a few sentences.",
  "listening.tuning": "`telephony_8k` for phone audio, `wideband_16k` for wideband.",

  handoff: "When and how the baton passes from the rep to the agent.",
  "handoff.allowedWhen": "The gate on the Pass button: a minimum call length and the fields that must be VERIFIED first.",
  "handoff.repLine": "The line the rep says to hand over; the customer's answer to it is the acceptance.",
  "handoff.acceptance": "The customer's go-ahead: the canonical phrase and the patterns that detect it.",
  "handoff.autoBaton": "Arm the pass automatically once the rep line and the acceptance are both heard.",
  "handoff.repReturnLine": "What the agent says when it hands the call back to the rep.",

  playbook: "What the agent is and does on the call: its voice, greeting, stages, disclosures and limits.",
  "playbook.voice": "The Voice Agent voice.",
  "playbook.persona": "Tone and extra rules that are added to the prompt.",
  "playbook.subject": "How the agent refers to what the case is about (a name once known, a noun phrase before that).",
  "playbook.greeting": "The first thing the agent says: the opening, the summary of the case, the opt-out and what comes next.",
  "playbook.greeting.opening": "Must state that this is an AI assistant, not a person, and that the call is recorded.",
  "playbook.greeting.maxWords": "The rendered greeting must fit in this many words (about 0.34 s per word).",
  "playbook.promptTemplate": "The agent prompt. `null` generates it from this blueprint.",
  "playbook.caseJson": "What the agent sees of the case: the header keys, the tables to include and a character budget.",
  "playbook.vaKeyterms": "Key terms handed to the Voice Agent: context paths and `f.<id>` field references.",
  "playbook.stages": "The ordered stages of the call. Each stage lists the tools the agent may use and how it exits.",
  "playbook.stages[].goal": "What the agent must achieve in this stage, in the words the prompt will use.",
  "playbook.stages[].tools": "The tools allowed in this stage, in order. `update_case_field` and `hand_back_to_rep` are required.",
  "playbook.stages[].exit": "What ends the stage: everything verified, a disclosure accepted, a connector succeeded, or the end.",
  "playbook.disclosures": "Texts the agent reads verbatim, with the tokens that must survive and what they require first.",
  "playbook.disclosures[].criticalTokens": "Parts of the text that must be spoken; empty renders are dropped.",
  "playbook.disclosures[].requiresReady": "Refuse to read this until every required field is VERIFIED.",
  "playbook.disclosures[].consent": "A yes to this disclosure counts as consent for the acting stage.",
  "playbook.builtinToolText": "Overrides for the built-in tool texts; `null` keeps the default.",
  "playbook.sessionCap": "The agent's time budget: a base, a per-field allowance and a hard maximum, in seconds.",

  connectors: "What the relay may do in the world: payment links, e-sign, SMS, lookups and your own HTTPS endpoints.",
  "connectors[].url": "An `https://` URL. Never put a credential in it; reference a secret instead.",
  "connectors[].headers": "Request headers. A value is a literal string or a `{ \"$secret\": \"sec_…\" }` reference, never a key.",
  "connectors[].hmacSecret": "The secret used to sign the request body, as a `$secret` reference.",
  "connectors[].responsePick": "The only response paths handed to the agent; everything else in the response is dropped.",
  "connectors[].sideEffect": "True when the call changes something; such a connector is allowed only in an acting or closing stage.",
  "connectors[].timeoutMs": "Request timeout in milliseconds (500-5000).",

  qa: "Quality scoring for a finished call: which fields are re-asked, how close a verbatim reading must be, and the advice lexicon.",
  extraction: "How the transcript is turned into case updates: the domain and intent lines, the field guide and the context keys.",
  "extraction.fieldGuide": "The verbatim field guide for the extractor. `null` generates it from `fields`.",
  compliance: "What must be said and what must never be collected.",
  "compliance.aiDisclosurePatterns": "Patterns that must match the rendered greeting, proving the AI disclosure was said.",
  "compliance.recordingNoticePattern": "The pattern proving the recording notice was said.",
  "compliance.neverCollect": "Categories the relay must never collect. At least three.",
};
