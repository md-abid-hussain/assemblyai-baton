/**
 * relay/extractor.ts - the dynamic extractor (PLATFORM §5): the prompt, the strict `json_schema` output format and
 * the user-input builder, all generated from the blueprint, plus `assertStrictSchema`. WP14a. Pure and isomorphic.
 *
 * Baton sets `extraction.fieldGuide` to the verbatim V3 block, so its prompt, format and input are byte-identical to
 * case/extractor.ts and its version id equals `EXTRACTOR_VERSION_V3` (the existing extraction caches stay valid).
 * Every other relay's version id differs by construction, so WP3's cache keys stay correct.
 */
import type { CaseState } from "../contracts/case";
import type { TurnInput } from "../contracts/turns";
import type { AccountRecord, Blueprint, BlueprintField } from "../contracts/v2/blueprint";
import type { IntentSpec } from "../contracts/v2/relay";
import { WEEKDAYS, weekdayOf } from "../case/dates";
import {
  EXTRACT_RECENT_TURNS, EXTRACTOR_MODEL_ID, EXTRACTOR_REASONING_EFFORT, extractorVersionOf,
} from "../case/extractor";
import { fieldState, type Fields } from "./scope";
import { parseTemplatePath } from "./template";

/** The V3 invariant paragraph (verbatim, PLATFORM §5). */
export const EXTRACTOR_INVARIANT = `Emit events ONLY for what the NEW TURNS say. Never repeat facts from earlier turns unless a NEW TURN restates, reads back,
confirms, corrects or denies them. Never invent values. If nothing relevant is said, return {"events": [], "no_facts": true}.`;

/** The V3 event-kind block and the quote / turn_id lines (verbatim, PLATFORM §5). */
export const EXTRACTOR_EVENT_KINDS = `Event kinds:
- stated: the speaker gives a value, or proposes one in a question ("Is that the Civic?").
- readback: the speaker repeats a value the OTHER party gave, to check it.
- ack: the speaker affirms the other party's latest statement/readback ("yes", "that's right", "correct"). Set
  acknowledges_turn_id to that turn; value = the value being affirmed (or null if unclear).
- corrected: the speaker replaces an earlier value with a new one.
- denied: the speaker says an earlier value is wrong without giving a new one (value null).
- question: the speaker asks for a field without proposing a value (value null).
quote: the shortest exact span of the NEW TURN (verbatim, same casing) that carries the event.
turn_id: the id of the NEW TURN the event comes from.`;

const article = (noun: string): string => (/^[aeiou]/i.test(noun) ? `an ${noun}` : `a ${noun}`);

/** Format hints by normalizer (PLATFORM §5). */
function formatHint(f: BlueprintField, bp: Blueprint): string | null {
  switch (f.normalizer) {
    case "date": case "date_future":
      return "YYYY-MM-DD. Resolve relative dates (\"tomorrow\", \"next Friday\") against CALL DATE";
    case "date_of_birth": return "YYYY-MM-DD";
    case "money": return "dollars with cents (\"142.00\")";
    case "signed_money": return "dollars with cents, negative for a decrease (\"-12.50\")";
    case "us_zip5": return "5 digits";
    case "us_state": return "2-letter US state code (\"OH\")";
    case "us_phone": return "10 digits";
    case "boolean": return "\"true\" or \"false\"";
    case "integer": case "insurance.age": return "an integer";
    case "number": return "a number";
    case "email": return "an email address";
    case "id_code": return "as spoken, digits/letters only";
    case "lookup": case "insurance.vehicle": {
      const t = bp.context.tables.find((x) => x.id === f.lookup?.table);
      return `its id from ${(t?.label ?? f.lookup?.table ?? "the table").toUpperCase()}${f.lookup?.allowAll ? ", or \"all\"" : ""}`;
    }
    default: return null;
  }
}

/** One generated guide line per field: `- <id>: <description>. <hint>. [one of ….] [Only the REP can state this.]` */
export function generatedFieldGuide(bp: Blueprint): string {
  return bp.fields.map((f) => {
    const parts = [`- ${f.id}: ${f.description.replace(/\.\s*$/, "")}.`];
    const hint = formatHint(f, bp);
    if (hint) parts.push(`${hint}.`);
    if (f.enumValues?.length) parts.push(`One of ${f.enumValues.map((e) => e.value).join(", ")}.`);
    if (f.setBy === "rep_only") parts.push("Only the REP can state this.");
    return parts.join(" ");
  }).join("\n");
}

/** The extractor instructions (PLATFORM §5). */
export function extractorPrompt(bp: Blueprint): string {
  const { domainLine, intentLine, fieldGuide } = bp.extraction;
  const head = `You extract facts for ${domainLine} from a phone call between ${article(bp.meta.roles.org)} REP and ${article(bp.meta.roles.customer)} CUSTOMER.
Intent: ${intentLine}. You see the current case, recent turns, and one or more NEW TURNS.`;
  return `${head}\n${EXTRACTOR_INVARIANT}\n\nFields (value formats):\n${fieldGuide ?? generatedFieldGuide(bp)}\n${EXTRACTOR_EVENT_KINDS}`;
}

export interface StrictFormat { name: string; strict: true; schema: Record<string, unknown> }

/** `{ name: "<intent>_patch", strict: true, schema }`: the V3 schema with `field.enum` = the blueprint's field ids. */
export function extractorFormat(bp: Blueprint): StrictFormat {
  return {
    name: `${bp.meta.intent.id}_patch`,
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
              field: { type: "string", enum: bp.fields.map((f) => f.id) },
              kind: { type: "string", enum: ["stated", "readback", "ack", "corrected", "denied", "question"] },
              value: { type: ["string", "null"] },
              quote: { type: "string" },
              acknowledges_turn_id: { type: ["string", "null"] },
              confidence: { type: "string", enum: ["high", "medium", "low"] },
            },
          },
        },
      },
    },
  };
}

// ============================================================================================ strict-schema check

const STRICT_KEYWORDS = new Set(["type", "properties", "required", "additionalProperties", "items", "enum", "description"]);
const FORMAT_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;
export const STRICT_ENUM_MAX = 24;

export class StrictSchemaError extends Error {
  constructor(message: string) { super(message); this.name = "StrictSchemaError"; }
}

/**
 * OpenAI strict-mode rules (PLATFORM §5): every object has `additionalProperties: false` and `required` lists every
 * property; nullable values use `type: [T, "null"]`; only type/properties/required/additionalProperties/items/enum/
 * description appear; the name matches `^[A-Za-z0-9_-]{1,64}$`; an enum has ≤ 24 values. Throws `StrictSchemaError`.
 */
export function assertStrictSchema(format: { name: string; strict: boolean; schema: Record<string, unknown> }): void {
  if (!FORMAT_NAME_RE.test(format.name)) throw new StrictSchemaError(`format name "${format.name}" must match ${FORMAT_NAME_RE}`);
  if (format.strict !== true) throw new StrictSchemaError("strict must be true");
  const walk = (node: unknown, where: string): void => {
    if (typeof node !== "object" || node === null || Array.isArray(node)) throw new StrictSchemaError(`${where}: a schema must be an object`);
    const s = node as Record<string, unknown>;
    for (const k of Object.keys(s)) if (!STRICT_KEYWORDS.has(k)) throw new StrictSchemaError(`${where}: keyword "${k}" is not allowed in strict mode`);
    const types = Array.isArray(s.type) ? s.type : [s.type];
    if (!types.length || types.some((t) => typeof t !== "string")) throw new StrictSchemaError(`${where}: type must be a string or a list of strings`);
    if (Array.isArray(s.type) && !(s.type.length === 2 && s.type[1] === "null")) throw new StrictSchemaError(`${where}: a nullable type must be [T, "null"]`);
    if (s.enum !== undefined) {
      if (!Array.isArray(s.enum) || s.enum.length === 0) throw new StrictSchemaError(`${where}: enum must be a non-empty list`);
      if (s.enum.length > STRICT_ENUM_MAX) throw new StrictSchemaError(`${where}: enum has ${s.enum.length} values (max ${STRICT_ENUM_MAX})`);
    }
    if (types.includes("object")) {
      if (s.additionalProperties !== false) throw new StrictSchemaError(`${where}: additionalProperties must be false`);
      const props = s.properties;
      if (typeof props !== "object" || props === null) throw new StrictSchemaError(`${where}: an object needs properties`);
      const names = Object.keys(props);
      const req = Array.isArray(s.required) ? s.required : [];
      if (req.length !== names.length || names.some((n) => !req.includes(n))) throw new StrictSchemaError(`${where}: required must list every property`);
      for (const n of names) walk((props as Record<string, unknown>)[n], `${where}.${n}`);
    } else if (s.properties !== undefined || s.required !== undefined || s.additionalProperties !== undefined) {
      throw new StrictSchemaError(`${where}: properties/required/additionalProperties only on objects`);
    }
    if (types.includes("array")) walk(s.items, `${where}[]`);
    else if (s.items !== undefined) throw new StrictSchemaError(`${where}: items only on arrays`);
  };
  walk(format.schema, format.name);
}

// ============================================================================================ user input

type Turn = Pick<TurnInput, "turnId" | "channel" | "text">;
const speaker = (t: Pick<TurnInput, "channel">): "REP" | "CUSTOMER" => (t.channel === "rep" ? "REP" : "CUSTOMER");

/** Resolves an `extraction.context[].from` path (PLATFORM §5): template paths, `table.<id>` and `table.<id>.<col>`. */
export function resolveContextPath(from: string, bp: Blueprint, account: AccountRecord): unknown {
  const tm = /^table\.([a-z][a-z0-9_]*)(?:\.([a-z0-9_]+))?$/.exec(from);
  if (tm) {
    const def = bp.context.tables.find((t) => t.id === tm[1]);
    const rows = account.tables[tm[1]!] ?? [];
    if (tm[2]) return rows.map((r) => r[tm[2]!] ?? "");
    return rows.map((r) => ({ id: r[def?.idColumn ?? "id"] ?? "", label: r[def?.labelColumn ?? "label"] ?? "" }));
  }
  const ref = parseTemplatePath(from);
  if (!ref) return null;
  switch (ref.kind) {
    case "customer": {
      const c = account.customer;
      return ref.key === "fullName" ? `${c.firstName} ${c.lastName}` : c[ref.key];
    }
    case "org": return account.org.name;
    case "rep": return account.org.repFirstName;
    case "call": return account.callDate;
    case "fact": return account.facts[ref.key] ?? null;
    case "intent": return bp.meta.intent.summary;
    default: return null;
  }
}

/**
 * The user input JSON (PLATFORM §5): `case` holds the non-MISSING fields plus the required MISSING fields, in
 * blueprint order; the context object `{[contextKey]: {…}}` is built in `extraction.context` order.
 */
export function buildRelayExtractorInput(bp: Blueprint, spec: Pick<IntentSpec, "fieldIds" | "required">, i: {
  callDate: string; account: AccountRecord; state: Fields; recent: readonly Turn[]; newTurns: readonly Turn[];
}): string {
  const weekday = WEEKDAYS[weekdayOf(i.callDate)]!;
  const caseObj: Record<string, { value: string | null; status: string }> = {};
  for (const f of spec.fieldIds) {
    const st = fieldState(i.state, f);
    if (st && st.status !== "MISSING") caseObj[f] = { value: st.value, status: st.status };
    else if (spec.required.has(f)) caseObj[f] = { value: null, status: "MISSING" };
  }
  const ctx: Record<string, unknown> = {};
  for (const c of bp.extraction.context) ctx[c.key] = resolveContextPath(c.from, bp, i.account);
  return JSON.stringify({
    call_date: i.callDate,
    call_weekday: weekday[0]!.toUpperCase() + weekday.slice(1),
    [bp.extraction.contextKey]: ctx,
    case: caseObj,
    recent_turns: i.recent.slice(-EXTRACT_RECENT_TURNS).map((t) => ({ turn_id: t.turnId, speaker: speaker(t), text: t.text })),
    new_turns: i.newTurns.map((t) => ({ turn_id: t.turnId, speaker: speaker(t), text: t.text })),
  });
}

export interface CompiledExtractor {
  prompt: string;
  format: StrictFormat;
  versionId: string;
  buildInput(i: { callDate: string; account: AccountRecord; state: Pick<CaseState, "fields">; recent: readonly Turn[]; newTurns: readonly Turn[] }): string;
}

/** `compiled.extractor` (PLATFORM §5). The version pin is `extractorVersionOf(prompt, format, model, effort)`. */
export function compileExtractor(bp: Blueprint, spec: Pick<IntentSpec, "fieldIds" | "required">): CompiledExtractor {
  const prompt = extractorPrompt(bp);
  const format = extractorFormat(bp);
  return {
    prompt,
    format,
    versionId: extractorVersionOf(prompt, format, EXTRACTOR_MODEL_ID, EXTRACTOR_REASONING_EFFORT),
    buildInput: (i) => buildRelayExtractorInput(bp, spec, i),
  };
}
