/**
 * core/relay/draft/compliance.ts - the deterministic post-fixes of PLATFORM §7.4 step 5 (WP17·3).
 *
 * Applied to every drafted blueprint AFTER `expandDraft` and the schema/lint round, because these four are not
 * judgment calls and a model must never be trusted with them:
 *
 *  1. the greeting keeps its compliant opening ("AI assistant", "not a person", "recorded") and fits `maxWords`;
 *  2. the Rule 7 card-number guard: no field ever collects a card, bank, SSN or password, and `neverCollect` lists
 *     all four (the kernel safety block, §4.4, repeats this at run time for every relay);
 *  3. every disclosure is marked SAMPLE, so nothing reads as real legal text;
 *  4. denylisted real brands (lint B1) are replaced by the relay's own fictional business name.
 *
 * Pure. Returns a NEW blueprint and the notes that say what changed, so "Assumptions I made" never hides a fix.
 */
import type { Blueprint } from "../../contracts/v2/blueprint";
import { findDenylistedBrands, replaceDenylistedBrands } from "../brand-denylist";

/** The compliant opening every drafted relay starts from (identical to the blank relay's; 13 words). */
export const COMPLIANT_OPENING = "Hi {customer.firstName}, I'm {rep.firstName}'s AI assistant, not a person. This call is recorded.";
export const SHORT_SUMMARY = "I'll finish up from here.";
export const SHORT_OPT_OUT = "Ask for a person anytime.";
export const SAMPLE_MARK = "SAMPLE:";

/** A field that would collect one of these is removed outright, whatever it is called. */
const FORBIDDEN_FIELD =
  /\b(card|cardnumber|cvv|cvc|ccv|bank|routing|iban|accountnumber|ssn|social|password|passcode|pin)\b|\baccount number\b/;

/** Underscores become spaces, so `card_number` and "Card number" both hit `card`. */
const normalizeKey = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, " ");

export interface ComplianceResult {
  blueprint: Blueprint;
  notes: string[];
  /** What each fix touched, for the tests and the notes file. */
  applied: { greeting: boolean; removedFields: string[]; disclosures: number; brands: string[] };
}

/** Every author-written string of a blueprint that a real brand could hide in, with a setter. */
function prose(bp: Blueprint): { get(): string; set(v: string): void; name: boolean }[] {
  const out: { get(): string; set(v: string): void; name: boolean }[] = [];
  const add = (get: () => string, set: (v: string) => void, name = false) => out.push({ get, set, name });
  add(() => bp.meta.title, (v) => (bp.meta.title = v), true);
  add(() => bp.meta.tagline, (v) => (bp.meta.tagline = v));
  add(() => bp.meta.intent.summary, (v) => (bp.meta.intent.summary = v));
  add(() => bp.meta.intent.caseNoun, (v) => (bp.meta.intent.caseNoun = v));
  add(() => bp.handoff.repLine, (v) => (bp.handoff.repLine = v));
  add(() => bp.handoff.repReturnLine, (v) => (bp.handoff.repReturnLine = v));
  add(() => bp.playbook.persona.tone, (v) => (bp.playbook.persona.tone = v));
  add(() => bp.playbook.greeting.summary, (v) => (bp.playbook.greeting.summary = v));
  add(() => bp.listening.scenarioPrompt, (v) => (bp.listening.scenarioPrompt = v));
  add(() => bp.extraction.domainLine, (v) => (bp.extraction.domainLine = v));
  add(() => bp.extraction.intentLine, (v) => (bp.extraction.intentLine = v));
  bp.fields.forEach((f) => {
    add(() => f.label, (v) => (f.label = v));
    add(() => f.description, (v) => (f.description = v));
    f.examples.forEach((_, i) => add(() => f.examples[i]!, (v) => (f.examples[i] = v)));
  });
  bp.playbook.stages.forEach((s) => {
    add(() => s.label, (v) => (s.label = v));
    add(() => s.goal, (v) => (s.goal = v));
  });
  bp.playbook.disclosures.forEach((d) => {
    add(() => d.title, (v) => (d.title = v));
    add(() => d.text, (v) => (d.text = v));
    d.criticalTokens.forEach((_, i) => add(() => d.criticalTokens[i]!, (v) => (d.criticalTokens[i] = v)));
  });
  bp.connectors.forEach((c) => {
    add(() => c.label, (v) => (c.label = v));
    if ("description" in c) add(() => c.description, (v) => ((c as { description: string }).description = v));
    if ("smsTemplate" in c) add(() => c.smsTemplate, (v) => ((c as { smsTemplate: string }).smsTemplate = v));
    if ("template" in c) add(() => c.template, (v) => ((c as { template: string }).template = v));
    if ("documentTitle" in c) add(() => c.documentTitle, (v) => ((c as { documentTitle: string }).documentTitle = v));
  });
  bp.context.samples.forEach((s) => add(() => s.org.name, (v) => (s.org.name = v), true));
  return out;
}

/**
 * `fictionalName` is what a real brand becomes. The default keeps the relay's own sample business name, which
 * `expandDraft` already took from the draft - unless that name is itself denylisted, in which case a neutral
 * fictional name is used.
 */
export function applyComplianceFixes(input: Blueprint, opts: { fictionalName?: string } = {}): ComplianceResult {
  const bp = structuredClone(input) as Blueprint;
  const notes: string[] = [];
  const removedFields: string[] = [];
  const brands: string[] = [];

  // ---- 2. the card-number guard --------------------------------------------------------------------------
  const keep = bp.fields.filter((f) => {
    const hit = FORBIDDEN_FIELD.test(normalizeKey(f.id)) || FORBIDDEN_FIELD.test(normalizeKey(f.label));
    if (hit) removedFields.push(f.label);
    return !hit;
  });
  if (removedFields.length > 0 && keep.length > 0) {
    const gone = new Set(bp.fields.filter((f) => !keep.includes(f)).map((f) => f.id));
    bp.fields = keep;
    bp.handoff.allowedWhen.requireVerified = bp.handoff.allowedWhen.requireVerified.filter((id) => !gone.has(id));
    bp.qa.reaskTargets = bp.qa.reaskTargets.filter((id) => !gone.has(id));
    if (gone.has(subjectField(bp.playbook.subject) ?? "")) {
      bp.playbook.subject = `{?f.${keep[0]!.id}.verified}{f.${keep[0]!.id}|first_name}{:}you{/?}`;
    }
    notes.push(`Removed ${removedFields.length === 1 ? "a field" : `${removedFields.length} fields`} that would have collected card, bank or ID numbers (${removedFields.join(", ")}). The assistant never takes those on a call; a payment link does.`);
  }
  bp.compliance.neverCollect = ["card_number", "bank_account", "password", "ssn"];

  // ---- 1. the greeting ------------------------------------------------------------------------------------
  const g = bp.playbook.greeting;
  const openingOk = /AI assistant/i.test(g.opening) && /not a person/i.test(g.opening) && /recorded/i.test(g.opening);
  const greetingFixed = !openingOk;
  if (!openingOk) {
    g.opening = COMPLIANT_OPENING;
    notes.push("Rewrote the opening so the assistant says it is an AI, not a person, and that the call is recorded. This one is not optional.");
  }
  if (g.maxWords > 40) g.maxWords = 40;

  // ---- 3. disclosures are samples -------------------------------------------------------------------------
  let marked = 0;
  for (const d of bp.playbook.disclosures) {
    if (/\bSAMPLE\b/.test(d.text)) continue;
    d.text = `${SAMPLE_MARK} ${d.text}`.slice(0, 2400);
    marked++;
  }
  if (marked > 0) notes.push(`Marked ${marked === 1 ? "the disclosure" : `all ${marked} disclosures`} SAMPLE. Sample wording is a placeholder, never legal text - replace it with your own.`);

  // ---- 4. real brands --------------------------------------------------------------------------------------
  const ownName = opts.fictionalName ?? bp.context.samples[0]?.org.name ?? "Example Company";
  const replacement = findDenylistedBrands(ownName, "name").length === 0 ? ownName : "Example Company";
  for (const slot of prose(bp)) {
    const site = slot.name ? "name" : "prose";
    const text = slot.get();
    const hits = findDenylistedBrands(text, site);
    if (hits.length === 0) continue;
    for (const h of hits) if (!brands.includes(h.brand)) brands.push(h.brand);
    slot.set(replaceDenylistedBrands(text, replacement, site));
  }
  if (brands.length > 0) {
    notes.push(`Replaced real company names (${brands.slice(0, 3).join(", ")}) with "${replacement}". Everything in a relay is fictional.`);
  }

  return { blueprint: bp, notes, applied: { greeting: greetingFixed, removedFields, disclosures: marked, brands } };
}

/** The field id a `{?f.<id>.verified}…` subject template names, if it names one. */
function subjectField(subject: string): string | null {
  return /\{\?f\.([a-z][a-z0-9_]*)\./.exec(subject)?.[1] ?? null;
}
