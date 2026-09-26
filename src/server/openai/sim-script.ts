/**
 * server/openai/sim-script.ts - the simulated call's SCRIPT (PLATFORM §7.5 step 1; WP17·2).
 *
 * `gpt-6-luna`, effort "low", strict `json_schema` named `sim_script`: the human half of a relay's call, written for
 * one fictional sample, ending on the rep's EXACT handoff line and the customer's acceptance. The voicing (TTS),
 * assembly and the row are WP17·1 (`src/server/sim/{generate,assemble}.ts`); the TEXT DRY RUN (§7.5.2) uses the same
 * script with no audio.
 *
 * Validation is the whole point of this file: a script that breaks a rule is REGENERATED once, with the issue list
 * fed back, and only then fails. Rules (§7.5 step 1):
 *   8-14 turns, the first by the rep, ≤ 1200 characters over all turns;
 *   the handoff turn's similarity to `handoff.repLine` ≥ 0.85 (`planSimLines` then puts the exact line in);
 *   the acceptance turn comes next and matches `handoff.acceptance.patterns` (through `safeTest()`, never `RegExp`);
 *   no digit run ≥ 12 (the card-number guard); only the sample's names;
 *   `left_for_ai` = 1-3 required `ai_allowed` fields, each with a spoken AI-half answer.
 *
 * Spend: one ledger reservation per attempt (provider `openai`, action `sim_script`), settled from the response's
 * usage at luna list prices. A refused reservation throws `E_BUDGET` before any request is made.
 */
import "server-only";

import type OpenAI from "openai";

import { SIM_TURN_TAGS, SimScriptSchema, type SimScript } from "../../core/contracts/v2/api";
import type { Blueprint } from "../../core/contracts/v2/blueprint";
import { safeTest } from "../../core/contracts/v2/regex";
import { BatonError } from "../../core/contracts/errors";
import type { SpendLedger } from "../../core/contracts/services";
import { verbatimSimilarity } from "../../core/qa/verbatim";
import { log } from "../log";
import { extractStructured, IncompleteError, MODELS, type OnTrace, type ReasoningEffort } from "./client";
import { usdOfUsage } from "./extractor";

const scriptLog = log.child({ component: "sim-script" });

export const SIM_SCRIPT_MODEL = MODELS.fast;
export const SIM_SCRIPT_EFFORT: ReasoningEffort = "low";
/** ≈ 1200 characters of dialogue is ≈ 350 visible tokens; the rest is headroom for low-effort reasoning. */
export const SIM_SCRIPT_MAX_OUTPUT_TOKENS = 3000;
export const SIM_SCRIPT_TIMEOUT_MS = 60_000;
/** The reservation per attempt (the real cost is ≈ $0.001; settled from usage). */
export const SIM_SCRIPT_EST_USD = 0.004;

export const SIM_SCRIPT_MIN_TURNS = 8;
export const SIM_SCRIPT_MAX_TURNS = 14;
export const SIM_SCRIPT_MAX_CHARS = 1200;
/** The lower end of "≈ 60-75 s of human half" (§7.5): a shorter call leaves Express almost nothing to prefill. */
export const SIM_SCRIPT_TARGET_CHARS = 900;
/** Token-level similarity of the handoff turn to `handoff.repLine` before it is replaced by the exact line. */
export const SIM_HANDOFF_MIN_SIMILARITY = 0.85;
/** A digit run this long is a card number, whatever it is called (kernel safety block, PLATFORM §4.4 rule 7). */
export const SIM_MAX_DIGIT_RUN = 12;

export class SimScriptInvalidError extends Error {
  constructor(readonly issues: readonly string[], readonly attempts: number) {
    super(`the simulated call's script is not usable: ${issues.join("; ")}`);
    this.name = "SimScriptInvalidError";
  }
}

// ============================================================================================ the strict schema

/**
 * The `sim_script` format. The field enums are the relay's own field ids, so luna cannot name a field that does not
 * exist. Strict mode: every object carries `additionalProperties:false` and lists every key in `required`, and no
 * keyword outside the supported subset appears (counts are checked in `validateSimScript`, not in the schema).
 */
export function simScriptFormat(fieldIds: readonly string[]): { name: string; strict: true; schema: Record<string, unknown> } {
  const fieldEnum = { type: "string", enum: [...fieldIds] };
  return {
    name: "sim_script",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["turns", "left_for_ai", "ai_half_answers", "consent_phrase", "closing_phrase"],
      properties: {
        turns: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["speaker", "text", "tag"],
            properties: {
              speaker: { type: "string", enum: ["rep", "customer"] },
              text: { type: "string" },
              tag: { type: "string", enum: [...SIM_TURN_TAGS] },
            },
          },
        },
        left_for_ai: { type: "array", items: fieldEnum },
        ai_half_answers: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["field", "spoken"],
            properties: { field: fieldEnum, spoken: { type: "string" } },
          },
        },
        consent_phrase: { type: "string" },
        closing_phrase: { type: "string" },
      },
    },
  };
}

// ============================================================================================ the prompt

export const SIM_SCRIPT_INSTRUCTIONS = `You write the HUMAN HALF of a short, realistic recorded phone call, for a product demo. Everyone in it is fictional.

The call: the REP (a person at the business) is on the phone with the CUSTOMER. They get most of the way through the
task together. Then the REP hands the call over to an AI assistant, which finishes it after your script ends.

Write ONLY the part before the handover. Rules:
1. ${SIM_SCRIPT_MIN_TURNS}-${SIM_SCRIPT_MAX_TURNS} turns, alternating naturally; the BUDGET line at the end says how many to write. The FIRST turn is the rep
   greeting the customer by name.
2. The BUDGET line also gives a hard character limit over ALL turns and a per-turn length. NEVER exceed either: a
   real call, not a form. People say why they are calling, ask a question back, and the rep reads back as well as
   explains. Spoken English, contractions, no stage directions, no speaker labels inside the text, no emoji, no
   markdown. Count your characters before you answer; if you are over, cut words, not turns.
3. The SECOND-TO-LAST turn is the rep saying the handoff line EXACTLY as given under HANDOFF LINE, word for word,
   tagged "handoff". The LAST turn is the customer accepting, tagged "accept", close to the acceptance phrase given.
4. Between them, the rep settles EVERY field listed under SETTLE IN THE CALL: the customer says each value and the
   rep reads it back or confirms it, except the ones marked "[the REP states this one]", which the rep says and the
   customer confirms. Use the values under SAMPLE exactly (dates spoken naturally, e.g. "Tuesday the sixth").
5. Do NOT settle the fields under LEAVE FOR THE AI, and do not mention them at all. Return their ids in left_for_ai,
   and for each one an ai_half_answers entry: the short sentence the customer will say when the AI asks for it later.
6. Never write a digit run of ${SIM_MAX_DIGIT_RUN} or more, and never a card, bank or account number: this is a booking or a
   service call, not a payment call. Prices and amounts are fine.
7. Use ONLY the names under SAMPLE. Invent no other person, business, brand, product or plan name.
8. consent_phrase: the short yes the customer will say when the AI asks to text them a link ("Yes, please text me the
   link."). closing_phrase: the short no when the AI asks if there is anything else ("No, that's everything, thanks.").
9. Tags: greet, ask, answer, readback, confirm, advice, handoff, accept, other. Tag the handoff and accept turns exactly.`;

interface PromptField {
  id: string;
  label: string;
  description: string;
  example: string | null;
  /** `rep_only`: the rep says this value, the customer does not (PLATFORM §3.2). */
  repStates?: boolean;
}

const fieldLine = (f: PromptField): string =>
  `- ${f.id} ("${f.label}"): ${f.description}${f.example ? ` e.g. ${f.example}` : ""}${f.repStates ? " [the REP states this one]" : ""}`;

export interface SimScriptContext {
  blueprint: Pick<Blueprint, "meta" | "context" | "fields" | "handoff" | "playbook">;
  sampleIndex: number;
  /** Required `ai_allowed` field ids the script must NOT settle (1-3). Default: the last one. */
  leaveForAi?: readonly string[];
}

/** The required `ai_allowed` fields a script may leave for the AI half. */
export const aiAllowedRequired = (bp: Pick<Blueprint, "fields">): string[] =>
  bp.fields.filter((f) => f.required && f.setBy === "ai_allowed").map((f) => f.id);

/**
 * The BUDGET block: how many turns to write and how long each may be, so the whole script fits
 * `SIM_SCRIPT_MAX_CHARS`. Fewer fields buy a longer, more natural call; more fields buy fewer, shorter turns.
 */
export function budgetLines(fieldsToSettle: number): string[] {
  const turns = fieldsToSettle >= 5 ? 10 : fieldsToSettle >= 4 ? 12 : SIM_SCRIPT_MAX_TURNS;
  const perTurn = Math.floor(SIM_SCRIPT_MAX_CHARS / turns);
  return [
    `BUDGET: write exactly ${turns} turns. At most ${perTurn} characters per turn, and at most ${SIM_SCRIPT_MAX_CHARS} over ALL turns.`,
    `Use the budget: a script much under ${SIM_SCRIPT_TARGET_CHARS} characters is too thin to sound like a real call.`,
    fieldsToSettle >= 5
      ? `You have ${fieldsToSettle} fields to settle in ${turns} turns, so it is tight: one short sentence per turn, settle two fields in a turn where it sounds natural, and no small talk.`
      : `You have ${fieldsToSettle} ${fieldsToSettle === 1 ? "field" : "fields"} to settle, so there is room for the call to sound unhurried.`,
  ];
}

export function buildSimScriptInput(c: SimScriptContext): string {
  const { blueprint: bp } = c;
  const sample = bp.context.samples[c.sampleIndex];
  if (!sample) throw new RangeError(`sample ${c.sampleIndex} does not exist`);
  const leave = new Set(c.leaveForAi ?? aiAllowedRequired(bp).slice(-1));
  /**
   * Everything the human half settles: every REQUIRED field except the ones deliberately left for the AI and the
   * ones a server value supplies. WP17·2 listed only the `ai_allowed` ones, which fits the curated gallery relay
   * (nearly all of its fields are) but starves a DRAFTED relay, where most fields are `rep_only` or
   * `rep_or_customer`: the script then had two lines to write and settled one field of six (live, 2026-09-25).
   */
  const settle = bp.fields.filter((f) => f.required && !leave.has(f.id) && !f.serverResolvable);
  const toPrompt = (f: Blueprint["fields"][number]): PromptField => ({
    id: f.id,
    label: f.label,
    description: f.description,
    example: f.examples[0] ?? null,
    repStates: f.setBy === "rep_only",
  });
  return [
    `BUSINESS: ${sample.org.name} (${bp.meta.roles.org}), a US business. TASK: ${bp.meta.intent.summary}.`,
    `TODAY: ${sample.callDate}.`,
    `SAMPLE (the only names you may use)`,
    `- rep: ${sample.org.repFirstName} (${bp.meta.roles.rep}) at ${sample.org.name}`,
    `- customer: ${sample.customer.firstName} ${sample.customer.lastName} (${bp.meta.roles.customer})`,
    ...Object.entries(sample.facts).map(([k, v]) => `- ${k}: ${v}`),
    ``,
    `SETTLE IN THE CALL`,
    ...settle.map((f) => fieldLine(toPrompt(f))),
    ``,
    `LEAVE FOR THE AI (never mentioned in your script)`,
    ...bp.fields.filter((f) => leave.has(f.id)).map((f) => fieldLine(toPrompt(f))),
    ``,
    `HANDOFF LINE (the second-to-last turn, verbatim)`,
    bp.handoff.repLine,
    `ACCEPTANCE (the last turn, close to this)`,
    bp.handoff.acceptance.phrase,
    ``,
    `TONE: ${bp.playbook.persona.tone}`,
  ].join("\n");
}

// ============================================================================================ validation

const DIGIT_RUN = new RegExp(`\\d[\\d\\s-]{${SIM_MAX_DIGIT_RUN - 1},}`);
const digitRun = (text: string): boolean => {
  const m = DIGIT_RUN.exec(text);
  return m !== null && m[0].replace(/\D/g, "").length >= SIM_MAX_DIGIT_RUN;
};

/** Capitalized multi-word sequences: a cheap "did it invent a person or a brand?" probe. */
const NAME_RUN = /\b[A-Z][a-z]{1,}(?: [A-Z][a-z]{1,})+\b/g;
/** Capitalized words that start sentences or are calendar words are not names. */
const NOT_A_NAME = new Set([
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
  "january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november",
  "december", "the", "a", "an", "and", "of", "at", "on", "in", "for", "to", "your", "my", "our", "is", "it", "we",
  "you", "i", "that", "this", "great", "perfect", "thanks", "thank", "sure", "okay", "ok", "yes", "no", "hi", "hello",
  "morning", "afternoon", "evening", "am", "pm", "dr", "mr", "mrs", "ms",
]);

const wordsOf = (s: string): string[] => s.toLowerCase().match(/[a-z]+/g) ?? [];

/** Words the sample allows: the people, the business, and every fact value. */
export function allowedNameWords(sample: Blueprint["context"]["samples"][number]): Set<string> {
  const out = new Set<string>(NOT_A_NAME);
  const add = (s: string) => wordsOf(s).forEach((w) => out.add(w));
  add(`${sample.customer.firstName} ${sample.customer.lastName}`);
  add(`${sample.org.name} ${sample.org.repFirstName}`);
  if (sample.customer.address) add(`${sample.customer.address.line1} ${sample.customer.address.city}`);
  for (const v of Object.values(sample.facts)) add(v);
  for (const rows of Object.values(sample.tables)) for (const r of rows) for (const v of Object.values(r)) add(v);
  return out;
}

/** Capitalized sequences in `text` that the sample does not license. */
export function foreignNames(text: string, allowed: ReadonlySet<string>): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(NAME_RUN)) {
    const seq = m[0];
    if (wordsOf(seq).every((w) => allowed.has(w))) continue;
    out.push(seq);
  }
  return out;
}

/**
 * Drop whole turns until the script fits the character budget, without ever rewriting a word the model wrote.
 * Only middle turns tagged `other` or `advice` go - never the opening, the handoff or the acceptance - and never
 * below `SIM_SCRIPT_MIN_TURNS`. It exists because a drafted relay with five or more fields regularly lands a few
 * characters over (1206 of 1200, live, 2026-09-25) and failing a whole dry run over six characters is silly. The
 * salvage is used only when the character budget is the ONLY thing wrong with an otherwise valid script.
 */
export function trimSimScript(script: SimScript, maxChars = SIM_SCRIPT_MAX_CHARS): { script: SimScript; dropped: number } {
  const turns = [...script.turns];
  const charsOf = (ts: SimScript["turns"]): number => ts.reduce((n, t) => n + t.text.length, 0);
  while (charsOf(turns) > maxChars && turns.length > SIM_SCRIPT_MIN_TURNS) {
    let at = -1;
    for (let i = turns.length - 3; i >= 1; i--) {
      const tag = turns[i]!.tag;
      if (tag === "other" || tag === "advice") { at = i; break; }
    }
    if (at < 0) break;
    turns.splice(at, 1);
  }
  return { script: { ...script, turns }, dropped: script.turns.length - turns.length };
}

export interface SimScriptValidation {
  ok: boolean;
  issues: string[];
  /** The parsed script (present whenever the shape was legal, even if a rule failed). */
  script: SimScript | null;
  chars: number;
  handoffSimilarity: number | null;
}

/** Every §7.5 step 1 rule. `issues` are written to be fed straight back to the model on the regeneration. */
export function validateSimScript(raw: unknown, c: SimScriptContext): SimScriptValidation {
  const issues: string[] = [];
  const parsed = SimScriptSchema.safeParse(raw);
  if (!parsed.success) {
    for (const i of parsed.error.issues.slice(0, 6)) issues.push(`${i.path.join(".") || "script"}: ${i.message}`);
    return { ok: false, issues, script: null, chars: 0, handoffSimilarity: null };
  }
  const script = parsed.data;
  const bp = c.blueprint;
  const sample = bp.context.samples[c.sampleIndex];
  if (!sample) throw new RangeError(`sample ${c.sampleIndex} does not exist`);

  const chars = script.turns.reduce((s, t) => s + t.text.length, 0);
  if (chars > SIM_SCRIPT_MAX_CHARS) issues.push(`the script is ${chars} characters; the limit is ${SIM_SCRIPT_MAX_CHARS} over all turns`);
  if (script.turns[0]!.speaker !== "rep") issues.push("the first turn must be the rep's");

  const last = script.turns[script.turns.length - 1]!;
  const prev = script.turns[script.turns.length - 2]!;
  let handoffSimilarity: number | null = null;
  if (prev.speaker !== "rep") {
    issues.push("the second-to-last turn must be the rep's handoff line");
  } else {
    handoffSimilarity = verbatimSimilarity(bp.handoff.repLine, prev.text);
    if (handoffSimilarity < SIM_HANDOFF_MIN_SIMILARITY) {
      issues.push(`the second-to-last turn is not the handoff line (similarity ${handoffSimilarity.toFixed(2)}); say it word for word: "${bp.handoff.repLine}"`);
    }
  }
  if (last.speaker !== "customer") {
    issues.push("the last turn must be the customer accepting the handover");
  } else {
    const pats = bp.handoff.acceptance.patterns;
    const accepts = pats.length === 0 ? true : pats.some((p) => safeTest(p, last.text));
    if (!accepts) issues.push(`the last turn must accept the handover, like "${bp.handoff.acceptance.phrase}"`);
  }
  for (const t of script.turns) {
    if (digitRun(t.text)) {
      issues.push(`"${t.text.slice(0, 60)}" contains a long digit run; never write ${SIM_MAX_DIGIT_RUN} or more digits`);
      break;
    }
  }
  const allowed = allowedNameWords(sample);
  const foreign = [...new Set(script.turns.flatMap((t) => foreignNames(t.text, allowed)))];
  if (foreign.length) issues.push(`these names are not in the sample: ${foreign.slice(0, 4).join(", ")}; use only ${sample.customer.firstName} ${sample.customer.lastName}, ${sample.org.repFirstName} and ${sample.org.name}`);

  const allowedLeave = new Set(c.leaveForAi ?? aiAllowedRequired(bp));
  for (const id of script.left_for_ai) {
    if (!allowedLeave.has(id)) issues.push(`left_for_ai names "${id}", which is not a required field the AI may set`);
  }
  const answered = new Set(script.ai_half_answers.map((a) => a.field));
  for (const id of script.left_for_ai) if (!answered.has(id)) issues.push(`ai_half_answers has no spoken answer for "${id}"`);
  for (const a of script.ai_half_answers) {
    if (!script.left_for_ai.includes(a.field)) issues.push(`ai_half_answers has "${a.field}", which is not in left_for_ai`);
    if (!a.spoken.trim()) issues.push(`the spoken answer for "${a.field}" is empty`);
  }
  if (!script.consent_phrase.trim()) issues.push("consent_phrase is empty");
  if (!script.closing_phrase.trim()) issues.push("closing_phrase is empty");

  return { ok: issues.length === 0, issues, script, chars, handoffSimilarity };
}

// ============================================================================================ the call

export interface SimScriptDeps {
  openai: () => OpenAI;
  /** `getLimitsAuthority().ledger`; null = spend not recorded (unit tests only). */
  ledger: () => SpendLedger | null;
  env: () => string;
  model?: string;
  timeoutMs?: number;
  onTrace?: OnTrace;
}

export interface SimScriptResult {
  script: SimScript;
  usd: number;
  attempts: number;
  ms: number;
  chars: number;
  handoffSimilarity: number | null;
}

/**
 * One luna call, validated; on failure ONE regeneration that is shown its own output and the issue list. An
 * `incomplete` response (`IncompleteError`) counts as that regeneration, exactly like a rule failure.
 */
export async function generateSimScript(d: SimScriptDeps, c: SimScriptContext & { refId: string }): Promise<SimScriptResult> {
  const fieldIds = c.blueprint.fields.map((f) => f.id);
  const format = simScriptFormat(fieldIds);
  const base = buildSimScriptInput(c);
  const t0 = performance.now();
  let usd = 0;
  let last: SimScriptValidation | null = null;
  let lastRaw: unknown = null;

  for (let attempt = 1; attempt <= 2; attempt++) {
    const input =
      attempt === 1
        ? base
        : [base, ``, `YOUR PREVIOUS SCRIPT`, JSON.stringify(lastRaw), ``, `WHAT IS WRONG WITH IT (fix all of it, keep the rest)`, ...(last?.issues ?? ["it did not finish; make it shorter"]).map((i) => `- ${i}`)].join("\n");
    const ledger = d.ledger();
    let reservation: string | null = null;
    if (ledger) {
      const res = await ledger.reserve({ provider: "openai", action: "sim_script", refId: c.refId, estUsd: SIM_SCRIPT_EST_USD, env: d.env() });
      if (!res.ok) throw new BatonError("E_BUDGET", "Today's script budget is used up.", { fallback: "cached_turn_replay" });
      reservation = res.id;
    }
    let raw: unknown;
    try {
      const r = await extractStructured<unknown>(d.openai(), {
        model: d.model ?? SIM_SCRIPT_MODEL,
        instructions: SIM_SCRIPT_INSTRUCTIONS,
        input,
        format,
        reasoningEffort: SIM_SCRIPT_EFFORT,
        maxOutputTokens: SIM_SCRIPT_MAX_OUTPUT_TOKENS,
        store: false,
        request: { timeoutMs: d.timeoutMs ?? SIM_SCRIPT_TIMEOUT_MS, maxRetries: 0 },
        ...(d.onTrace ? { onTrace: d.onTrace } : {}),
        label: "sim_script",
      });
      raw = r.data;
      const spent = usdOfUsage(r.usage);
      usd += spent;
      if (ledger && reservation) await ledger.settle(reservation, spent).catch((err: unknown) => scriptLog.warn("ledger settle failed", { err }));
    } catch (e) {
      const incomplete = e instanceof IncompleteError;
      if (ledger && reservation) {
        // An incomplete response was generated and billed; a transport failure was not.
        await (incomplete ? ledger.settle(reservation, SIM_SCRIPT_EST_USD) : ledger.release(reservation)).catch((err: unknown) => scriptLog.warn("ledger close failed", { err }));
      }
      if (incomplete) usd += SIM_SCRIPT_EST_USD;
      if (!incomplete || attempt === 2) {
        if (incomplete) throw new SimScriptInvalidError(["the model ran out of output tokens twice"], attempt);
        throw e;
      }
      last = null;
      lastRaw = null;
      continue;
    }
    lastRaw = raw;
    last = validateSimScript(raw, c);
    if (last.ok && last.script) {
      return { script: last.script, usd: Math.round(usd * 1e6) / 1e6, attempts: attempt, ms: Math.round(performance.now() - t0), chars: last.chars, handoffSimilarity: last.handoffSimilarity };
    }
    scriptLog.warn("sim script rejected", { attempt, issues: last.issues.length });
  }
  // Last resort: the script is good but a few characters long. Drop a middle aside rather than throw it away.
  if (last?.script && last.issues.length === 1 && last.issues[0]!.startsWith("the script is ")) {
    const trimmed = trimSimScript(last.script);
    const revalidated = validateSimScript(trimmed.script, c);
    if (revalidated.ok && revalidated.script) {
      scriptLog.warn("sim script trimmed to fit the character budget", { dropped: trimmed.dropped, chars: revalidated.chars });
      return { script: revalidated.script, usd: Math.round(usd * 1e6) / 1e6, attempts: 2, ms: Math.round(performance.now() - t0), chars: revalidated.chars, handoffSimilarity: revalidated.handoffSimilarity };
    }
  }
  throw new SimScriptInvalidError(last?.issues ?? ["no script"], 2);
}
