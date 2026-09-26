/**
 * core/relay/draft/expand.ts - `expandDraft(draft)` (PLATFORM §7.4 step 3; WP17·3).
 *
 * The deterministic half of the wizard. luna returns judgment (schema.ts); this turns it into a whole `Blueprint`:
 * normalizers and formatters from the field type, ask/confirm phrases and QA patterns from the label, the greeting
 * skeleton with a compliant opening, `promptTemplate: null` (generated, §4.4), the stage tool lists, `sessionCap`,
 * `listening.scenarioPrompt` from the intent, keyterms from the labels and the sample, and one or two fictional
 * sample accounts.
 *
 * It also **repairs structure rather than trusting the model**, so a drafted relay is normally lint-clean on the
 * first try: stage kinds are re-ordered to confirm < disclose < act < close with no repeats, every stage gets its
 * built-in tools and the right exit, an act stage keeps only connectors that really act and is dropped when none
 * does, `consent` is set on exactly the disclosure that gates the act stage (lint C2), a payment link always names a
 * money value, and an `adviceDomain` field is never `ai_allowed` (lint F1). Every repair is recorded in `notes`, so
 * "Assumptions I made" says what changed.
 *
 * Pure and isomorphic: same draft in, byte-identical blueprint out.
 */
import {
  BLUEPRINT_SCHEMA, type AccountRecord, type Blueprint, type BlueprintField, type Connector,
} from "../../contracts/v2/blueprint";
import type { DraftBlueprint, DraftConnector, DraftField } from "./schema";

const STAGE_ORDER = ["confirm", "disclose", "act", "close"] as const;
type StageKind = (typeof STAGE_ORDER)[number];

/** The two tools every stage lists (lint S1). */
export const BUILTIN_STAGE_TOOLS = ["update_case_field", "hand_back_to_rep"] as const;

/** `type` decides the normalizer, the display formatter, how values compare, and whether STT treats it as an entity. */
const TYPE_RULES: Record<string, { normalizer: string; display: string; compare: "exact" | "token_subset"; entity: boolean; mode: "balanced" | "max_accuracy" }> = {
  text: { normalizer: "text", display: "raw", compare: "token_subset", entity: false, mode: "balanced" },
  person_name: { normalizer: "person_name", display: "title", compare: "token_subset", entity: true, mode: "max_accuracy" },
  date: { normalizer: "date", display: "spoken_date", compare: "exact", entity: true, mode: "balanced" },
  number: { normalizer: "number", display: "raw", compare: "exact", entity: false, mode: "balanced" },
  integer: { normalizer: "integer", display: "raw", compare: "exact", entity: false, mode: "balanced" },
  money: { normalizer: "money", display: "spoken_money", compare: "exact", entity: false, mode: "max_accuracy" },
  enum: { normalizer: "enum", display: "enum_label", compare: "exact", entity: false, mode: "balanced" },
  phone: { normalizer: "us_phone", display: "spoken_chars", compare: "exact", entity: true, mode: "max_accuracy" },
  zip: { normalizer: "us_zip5", display: "spoken_zip", compare: "exact", entity: true, mode: "max_accuracy" },
  state: { normalizer: "us_state", display: "state_name", compare: "exact", entity: false, mode: "balanced" },
  boolean: { normalizer: "boolean", display: "raw", compare: "exact", entity: false, mode: "balanced" },
  email: { normalizer: "email", display: "lower", compare: "exact", entity: true, mode: "max_accuracy" },
  id_code: { normalizer: "id_code", display: "spoken_chars", compare: "exact", entity: true, mode: "max_accuracy" },
};

const DEFAULT_RULE = TYPE_RULES.text!;

// ============================================================================================ small helpers

const lower = (s: string): string => s.trim().toLowerCase();
const clean = (s: string): string => s.replace(/\s+/g, " ").trim();
/** Regex-escape, so a label can be dropped into a QA pattern safely. */
const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const STOP_WORDS = new Set(["the", "a", "an", "of", "and", "or", "your", "their", "for", "to", "is", "new"]);

/** The content words of a label, lowercased: "Dental insurance carrier" → ["dental","insurance","carrier"]. */
export function labelWords(label: string): string[] {
  return (lower(label).match(/[a-z0-9]+/g) ?? []).filter((w) => !STOP_WORDS.has(w));
}

/**
 * The QA "did the AI ask for this?" patterns of a field: the whole label, and its last content word when that is a
 * distinct, long-enough noun. Both are literal and anchored on word boundaries, so they are safe by construction.
 */
export function qaAskPatterns(label: string): string[] {
  const words = labelWords(label);
  if (words.length === 0) return [];
  const whole = words.join("\\s+");
  const out = [`\\b(${whole})\\b`];
  const last = words[words.length - 1]!;
  if (words.length > 1 && last.length >= 5) out.push(`\\b(${esc(last)})\\b`);
  return out.map((p) => p.slice(0, 200));
}

/** `blank-relay` ≤ slug ≤ 48 chars, always legal for `MetaSchema` (`^[a-z0-9][a-z0-9-]{2,47}$`). */
export function safeSlug(raw: string, fallback = "drafted-relay"): string {
  const s = lower(raw).replace(/[^a-z0-9-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return s.length >= 3 ? s.slice(0, 48) : fallback;
}

/** A snake_case id that `IdSchema` accepts (`^[a-z][a-z0-9_]{1,39}$`), or the fallback. */
export function safeId(raw: string, fallback: string): string {
  const s = lower(raw).replace(/[^a-z0-9_]+/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "");
  const head = s.replace(/^[^a-z]+/, "");
  return /^[a-z][a-z0-9_]{1,39}$/.test(head) ? head : fallback;
}

/** Makes `id` unique inside `taken` by appending `_2`, `_3`, … (lint L1 spans every id in a blueprint). */
export function uniqueId(id: string, taken: Set<string>): string {
  if (!taken.has(id)) {
    taken.add(id);
    return id;
  }
  for (let n = 2; n < 100; n++) {
    const next = `${id.slice(0, 37)}_${n}`;
    if (!taken.has(next)) {
      taken.add(next);
      return next;
    }
  }
  const last = `${id.slice(0, 35)}_x`;
  taken.add(last);
  return last;
}

/** Four digits derived from a string, for a fictional `phoneLast4` that is stable across expansions. */
export function digits4(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) % 10000;
  return String(h).padStart(4, "0");
}

// ============================================================================================ fields

function expandField(f: DraftField, index: number, notes: string[]): BlueprintField {
  const rule = TYPE_RULES[f.type] ?? DEFAULT_RULE;
  const label = clean(f.label) || f.id.replace(/_/g, " ");
  const labelLower = lower(label);
  // lint F1: a rep decision can never be ai_allowed. The rep keeps it; the AI reads it and never changes it.
  let setBy = f.setBy;
  if (f.adviceDomain && setBy === "ai_allowed") {
    setBy = "rep_only";
    notes.push(`"${label}" is a decision the rep makes, so the assistant can read it but never change it.`);
  }
  const isEnum = f.type === "enum";
  const enumValues = isEnum
    ? f.enumValues.map((v) => ({ value: v.value, label: clean(v.label).slice(0, 60), synonyms: [], spokenForms: [clean(v.label).slice(0, 60)] }))
    : undefined;
  return {
    id: f.id,
    label: label.slice(0, 60),
    description: clean(f.description).slice(0, 300) || `The ${labelLower}.`,
    type: f.type as BlueprintField["type"],
    normalizer: rule.normalizer as BlueprintField["normalizer"],
    ...(enumValues ? { enumValues } : {}),
    required: f.required,
    setBy,
    adviceDomain: f.adviceDomain,
    promptVisibility: setBy === "rep_only" ? "rep_verified_only" : "always",
    validation: {},
    examples: f.example ? [clean(f.example).slice(0, 80)] : [],
    compare: rule.compare,
    display: rule.display as BlueprintField["display"],
    capture: { priority: index + 1, mode: rule.mode, entity: rule.entity },
    // "Can you confirm the appointment date is Tuesday the sixth?" - no `{subject}`, which renders "you" before a
    // possessive ("you's owner phone") whenever the name is not verified yet.
    phrases: { ask: `the ${labelLower}`, confirm: `the ${labelLower} is {f.${f.id}.display}` },
    qa: { ask: qaAskPatterns(label), weak: [] },
    ui: { group: null, hidden: false },
  };
}

// ============================================================================================ connectors

/**
 * The text message each connector kind sends. The link itself is appended by the runtime, never by the template
 * (PLATFORM §6.1), and `{...}` is a template path - which the model is told not to write, and which is stripped from
 * whatever it writes anyway, so a drafted relay can never ship a template that does not parse (lint L3).
 */
function defaultSms(type: DraftConnector["type"], amountValue: string | null): string {
  switch (type) {
    case "payment_link":
      return amountValue ? `{org.name}: pay your {v.${amountValue}|spoken_money} deposit here.` : "{org.name}: your secure payment link is here.";
    case "esign_mock":
      return "{org.name}: your document is ready to sign.";
    case "sms_mock":
      return "{org.name}: here's the information you asked for.";
    case "confirmation":
      return "{org.name}: you're all set. Thank you, {customer.firstName}.";
  }
}

const plainText = (s: string): string => clean(s.replace(/\{[^}]*\}/g, " "));

function expandConnector(c: DraftConnector, ctx: { amountValue: string | null; consentDisclosure: string | null; requires: string[] }): Connector {
  const base = { id: c.id, label: clean(c.label).slice(0, 60) };
  const tool = { toolName: c.toolName, description: clean(c.description).slice(0, 400) };
  const written = plainText(c.smsText ?? "");
  const sms = (written ? `{org.name}: ${written}` : defaultSms(c.type, ctx.amountValue)).slice(0, 400);
  switch (c.type) {
    case "payment_link":
      return {
        type: "payment_link", ...base, ...tool, provider: "mock", amount: ctx.amountValue!, esign: false,
        smsTemplate: sms, requiresDisclosure: ctx.consentDisclosure,
      };
    case "esign_mock":
      return {
        type: "esign_mock", ...base, ...tool,
        documentTitle: plainText(c.documentTitle ?? "").slice(0, 120) || `${base.label} agreement (SAMPLE)`,
        smsTemplate: sms, requiresDisclosure: ctx.consentDisclosure,
      };
    case "sms_mock":
      return { type: "sms_mock", ...base, ...tool, template: sms, params: { type: "object", required: [], properties: {} } };
    case "confirmation":
      return { type: "confirmation", ...base, ...tool, requires: ctx.requires.slice(0, 3), smsTemplate: sms };
  }
}

const ACTING = new Set(["payment_link", "esign_mock"]);

// ============================================================================================ samples

/** The customer's fictional mailing address. Always present: Polar prefills its billing form from it (§6.1). */
const ADDRESSES = [
  { line1: "418 Larkspur Lane", city: "Brookfield", state: "IL", zip: "60513" },
  { line1: "27 Windermere Court", city: "Fair Haven", state: "NJ", zip: "07704" },
] as const;

const SECOND_CUSTOMER = { firstName: "Priya", lastName: "Raghavan" } as const;

function sampleAccount(d: DraftBlueprint, callDate: string, which: 0 | 1): AccountRecord {
  const s = d.sample;
  const customer = which === 0
    ? { firstName: clean(s.customerFirstName).slice(0, 40), lastName: clean(s.customerLastName).slice(0, 40) }
    : SECOND_CUSTOMER;
  const facts: Record<string, string> = {};
  for (const f of s.facts) {
    const key = safeId(f.key, "");
    if (key) facts[key] = clean(f.value).slice(0, 200);
  }
  return {
    customer: {
      ...customer,
      phoneLast4: digits4(`${customer.firstName}${customer.lastName}${which}`),
      address: ADDRESSES[which],
    },
    org: { name: clean(s.businessName).slice(0, 80), repFirstName: clean(s.repFirstName).slice(0, 40) },
    callDate,
    facts,
    tables: {},
  };
}

// ============================================================================================ expandDraft

export interface ExpandOptions {
  /** The sample accounts' call date (`YYYY-MM-DD`). */
  callDate: string;
  /** Two fictional samples by default; one is enough for a relay that will only ever be dry-run. */
  samples?: 1 | 2;
}

export interface ExpandedDraft {
  blueprint: Blueprint;
  /** The model's own notes, then every repair this function made. */
  notes: string[];
}

export function expandDraft(d: DraftBlueprint, o: ExpandOptions): ExpandedDraft {
  const notes = d.notes.map((n) => clean(n)).filter(Boolean);
  const taken = new Set<string>();

  // ---- fields (ids first, so every later id avoids them) -------------------------------------------------
  const fields = d.fields.slice(0, 12).map((f, i) => expandField({ ...f, id: uniqueId(f.id, taken) }, i, notes));
  if (!fields.some((f) => f.required)) {
    fields[0]!.required = true;
    notes.push(`Marked "${fields[0]!.label}" as required: a relay needs at least one thing to finish.`);
  }
  // The AI must be able to finish something, or the handoff is pointless.
  if (!fields.some((f) => f.required && f.setBy === "ai_allowed")) {
    const candidate = fields.find((f) => f.required && !f.adviceDomain);
    if (candidate) {
      candidate.setBy = "ai_allowed";
      candidate.promptVisibility = "always";
      notes.push(`Left "${candidate.label}" for the assistant to finish, so the handover has something to do.`);
    }
  }

  // ---- values --------------------------------------------------------------------------------------------
  const values = d.values.slice(0, 4).map((v) => ({
    id: uniqueId(v.id, taken),
    label: clean(v.label).slice(0, 60),
    type: v.type,
    ref: { kind: "fixed" as const, value: clean(v.value).slice(0, 60) },
  }));
  const moneyValue = values.find((v) => v.type === "money") ?? null;

  // ---- connectors ----------------------------------------------------------------------------------------
  const wanted = d.connectors.slice(0, 3).map((c) => ({ ...c, id: uniqueId(c.id, taken) }));
  const payment = wanted.find((c) => c.type === "payment_link") ?? null;
  let amountValue = moneyValue;
  if (payment && !amountValue) {
    const id = uniqueId(safeId(payment.amountValue ?? "amount_due", "amount_due"), taken);
    amountValue = { id, label: "Amount due", type: "money" as const, ref: { kind: "fixed" as const, value: "50.00" } };
    values.push(amountValue);
    notes.push("Set the amount to a sample $50.00 - change it to your real amount before you run this.");
  }

  // ---- disclosures ---------------------------------------------------------------------------------------
  const acting = wanted.filter((c) => ACTING.has(c.type));
  const disclosures = d.disclosures.slice(0, 4).map((x) => ({
    id: uniqueId(x.id, taken),
    title: clean(x.title).slice(0, 60),
    text: clean(x.text),
    criticalTokens: x.criticalTokens.map(clean).filter(Boolean).slice(0, 8),
    requiresReady: true,
    requiresAccepted: null as string | null,
    consent: false,
  }));
  if (acting.length > 0 && disclosures.length === 0) {
    // lint C2: an act stage needs a disclosure the customer accepted before it.
    const amount = amountValue ? `${clean(amountValue.label).toLowerCase()} of {v.${amountValue.id}|spoken_money}` : "this step";
    const text = `SAMPLE disclosure: before we go ahead, I need to tell you about the ${amount}. Is that okay?`;
    disclosures.push({
      id: uniqueId("consent_notice", taken), title: "Consent", text,
      criticalTokens: ["before we go ahead"], requiresReady: true, requiresAccepted: null, consent: false,
    });
    notes.push("Added a short consent notice: the assistant must read something before it takes a payment or a signature.");
  }
  for (const x of disclosures) {
    if (!x.text.includes("?")) x.text = `${x.text.replace(/[.\s]+$/, "")}. Is that okay?`;   // lint C2
    const normalized = lower(x.text);
    if (!x.criticalTokens.some((t) => t && normalized.includes(lower(t)))) {
      const first = (x.text.split(/(?<=[.?!])\s+/)[0] ?? x.text).slice(0, 120);
      x.criticalTokens = [first];
    }
    x.text = x.text.slice(0, 2400);
  }

  // ---- stages: one per kind, in order, with the right tools and exit ---------------------------------------
  const byKind = new Map<StageKind, (typeof d.stages)[number]>();
  for (const s of d.stages) if (!byKind.has(s.kind)) byKind.set(s.kind, s);
  if (d.stages.length > byKind.size) notes.push("Merged repeated stages: a relay runs confirm, then disclose, then act, then close, once each.");
  if (disclosures.length > 0 && !byKind.has("disclose")) {
    byKind.set("disclose", { id: "read_disclosure", kind: "disclose", label: "Disclose", goal: "Read the disclosure to {subject} word for word and get a yes.", useConnectors: [] });
  }
  if (acting.length > 0 && !byKind.has("act")) {
    byKind.set("act", { id: "take_action", kind: "act", label: "Act", goal: `Use ${acting[0]!.label.toLowerCase()} once {subject} has agreed.`, useConnectors: [acting[0]!.toolName] });
  }
  if (!byKind.has("close")) {
    byKind.set("close", { id: "wrap_up", kind: "close", label: "Close", goal: "Summarize what was done and close warmly.", useConnectors: [] });
  }
  if (acting.length === 0 && byKind.has("act")) {
    byKind.delete("act");   // lint S2: an act stage with nothing that acts
    notes.push("Dropped the payment step: this relay has nothing that takes a payment or a signature.");
  }
  if (disclosures.length === 0 && byKind.has("disclose")) byKind.delete("disclose");
  if (!byKind.has("confirm")) {
    byKind.set("confirm", { id: "confirm_details", kind: "confirm", label: "Confirm", goal: "Confirm the case details with {subject}.", useConnectors: [] });
  }

  const ordered = STAGE_ORDER.filter((k) => byKind.has(k)).map((k) => byKind.get(k)!);
  const actIndex = ordered.findIndex((s) => s.kind === "act");
  const gateDisclosure = actIndex >= 0 ? disclosures[disclosures.length - 1] ?? null : null;
  if (gateDisclosure) gateDisclosure.consent = true;   // lint C2: the disclosure the act stage waits on

  const byTool = new Map(wanted.map((c) => [c.toolName, c]));
  const stages = ordered.map((s, i) => {
    const id = uniqueId(safeId(s.id, `stage_${i + 1}`), taken);
    const allowed = s.kind === "act" || s.kind === "close";
    const picked = s.useConnectors
      .map((t) => byTool.get(t))
      .filter((c): c is DraftConnector => !!c && (allowed || !ACTING.has(c.type)));
    if (s.kind === "act" && !picked.some((c) => ACTING.has(c.type))) picked.push(acting[0]!);
    const tools = [...BUILTIN_STAGE_TOOLS as readonly string[]];
    if (s.kind === "disclose") tools.push("get_disclosure");
    for (const c of picked) if (!tools.includes(c.toolName)) tools.push(c.toolName);
    const exit = s.kind === "confirm"
      ? { kind: "all_required_verified" as const }
      : s.kind === "disclose"
        ? { kind: "disclosure_accepted" as const, disclosure: (gateDisclosure ?? disclosures[0]!).id }
        : s.kind === "act"
          ? { kind: "connector_succeeded" as const, connector: picked.find((c) => ACTING.has(c.type))!.id }
          : { kind: "end" as const };
    return { id, kind: s.kind, label: clean(s.label).slice(0, 40) || s.kind, goal: clean(s.goal).slice(0, 2400), tools: tools.slice(0, 6), exit };
  });

  // Only connectors some stage can call survive: an unreachable tool is dead weight and trips lint.
  const used = new Set(stages.flatMap((s) => s.tools));
  const keptDrafts = wanted.filter((c) => used.has(c.toolName));
  const connectors: Connector[] = keptDrafts.map((c) =>
    expandConnector(c, {
      amountValue: amountValue?.id ?? null,
      consentDisclosure: gateDisclosure?.id ?? null,
      requires: keptDrafts.filter((x) => ACTING.has(x.type)).map((x) => x.id),
    }),
  );
  if (keptDrafts.length < wanted.length) notes.push("Removed a connector no stage could reach.");

  // ---- listening, extraction, greeting -------------------------------------------------------------------
  const samples: AccountRecord[] = [sampleAccount(d, o.callDate, 0)];
  if ((o.samples ?? 2) === 2) samples.push(sampleAccount(d, o.callDate, 1));

  const keyterms = [...new Set([
    ...fields.flatMap((f) => (labelWords(f.label).length ? [f.label.toLowerCase()] : [])),
    ...fields.flatMap((f) => f.examples.map((e) => e.toLowerCase())),
    ...Object.values(samples[0]!.facts).map((v) => v.toLowerCase()),
  ])].filter((t) => t.length > 2 && t.length <= 50).slice(0, 40);

  const roles = { rep: clean(d.meta.roleRep).slice(0, 40) || "rep", customer: clean(d.meta.roleCustomer).slice(0, 40) || "customer", org: clean(d.meta.roleOrg).slice(0, 40) || "business" };
  const intentSummary = clean(d.meta.intentSummary).slice(0, 200);
  const scenarioPrompt = clean(
    `A ${roles.org} phone call where a human ${roles.rep} and the ${roles.customer} ${intentSummary}. ` +
    `The ${roles.rep} then hands the call to an AI assistant, which finishes it. Expect: ${fields.map((f) => f.label.toLowerCase()).join(", ")}.`,
  ).slice(0, 1750);

  const blueprint: Blueprint = {
    meta: {
      schema: BLUEPRINT_SCHEMA,
      slug: safeSlug(d.meta.slug),
      title: clean(d.meta.title).slice(0, 60) || "Drafted relay",
      tagline: clean(d.meta.tagline).slice(0, 140),
      industry: d.meta.industry,
      locale: "en-US",
      intent: {
        id: safeId(d.meta.slug.replace(/-/g, "_"), "finish_case"),
        summary: intentSummary || "finish the case the rep started",
        caseNoun: clean(d.meta.caseNoun).slice(0, 60) || `${roles.org} case`,
      },
      roles,
      origin: "draft",
      sampleOnly: true,
    },
    context: {
      facts: Object.keys(samples[0]!.facts).map((k) => ({ key: k, label: k.replace(/_/g, " ") })).slice(0, 16),
      tables: [],
      samples,
    },
    fields,
    values,
    listening: {
      keyterms,
      contextKeyterms: ["customer.fullName", "org.name"],
      languageCodes: ["en"],
      scenarioPrompt: scenarioPrompt.length >= 40 ? scenarioPrompt : `${scenarioPrompt} The assistant finishes what the ${roles.rep} started.`,
      tuning: "telephony_8k",
    },
    handoff: {
      allowedWhen: { minCallSeconds: 20, requireVerified: [] },
      repLine: clean(d.handoff.repLine).slice(0, 200),
      repLinePatterns: [],
      acceptance: { phrase: clean(d.handoff.acceptancePhrase).slice(0, 100) || "Sure, thanks.", patterns: ["\\b(sure|okay|ok|yes|yeah|please do)\\b"] },
      autoBaton: true,
      repReturnLine: clean(d.handoff.repReturnLine).slice(0, 200) || "I'm handing you back to the team now.",
    },
    playbook: {
      voice: d.persona.voice,
      persona: { tone: clean(d.persona.tone).slice(0, 200) || "warm and brief", extraRules: [] },
      subject: `{?f.${fields[0]!.id}.verified}{f.${fields[0]!.id}|first_name}{:}you{/?}`,
      greeting: {
        // The same 13-word opening the blank relay uses: it passes lint C1 and leaves room under maxWords for a
        // business of any length (docs/notes/requests/wp14a-to-wp14b.md §1).
        opening: "Hi {customer.firstName}, I'm {rep.firstName}'s AI assistant, not a person. This call is recorded.",
        // The whole summary is one droppable clause: a long closing sentence (a spoken phone number, a long label)
        // can push the rendered greeting over `maxWords`, and only a clause can be dropped (lint G2). The opening,
        // the opt-out and the next step are not negotiable, so this is the one sentence that may go.
        summary: "{clause.wrap}",
        clauses: [{ id: "wrap", text: "I'll finish up from here.", dropOrder: 0 }],
        optOut: "Ask for a person anytime.",
        next: { confirm: "Can you confirm {phrase.confirm}?", ask: "To finish up, I just need {phrase.ask}.", ready: "Is there anything else I can help with?" },
        maxWords: 40,
      },
      promptTemplate: null,
      caseJson: { header: [{ key: "business", from: "org.name" }], tables: [], maxChars: 1200 },
      vaKeyterms: ["customer.fullName"],
      stages,
      disclosures,
      builtinToolText: { updateCaseFieldValueHint: null },
      sessionCap: {
        baseSec: 120,
        perFieldSec: 15,
        maxSec: Math.min(420, Math.max(180, 120 + 15 * fields.filter((f) => f.required && f.setBy === "ai_allowed").length + (actIndex >= 0 ? 60 : 0))),
      },
    },
    connectors,
    qa: { reaskTargets: [], verbatimThreshold: 0.9, adviceLexicon: ["\\b(recommend\\w*|you should)\\b"] },
    extraction: {
      domainLine: `a ${roles.org} customer call`.slice(0, 300),
      intentLine: (intentSummary || "finish the case the rep started").slice(0, 300),
      fieldGuide: null,
      contextKey: "account",
      context: [{ key: "business", from: "org.name" }],
    },
    compliance: {
      aiDisclosurePatterns: ["AI assistant", "not a person"],
      recordingNoticePattern: "recorded",
      neverCollect: ["card_number", "bank_account", "password", "ssn"],
    },
  };

  return { blueprint, notes };
}
