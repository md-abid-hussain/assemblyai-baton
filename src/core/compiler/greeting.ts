/**
 * compiler/greeting.ts - the deterministic greeting compiler (DESIGN §5.6, shortened by PLATFORM v2.1 lint G2).
 * No LLM is involved. WP1 early deliverable (WP5 compile, WP9b sweep); owned by WP14a since G1.
 *
 * v2.1 (WP14a·2, closing wp5b-to-wp1 item 4): at most 40 words (WP5b measured 65–69 words = 22–24 s of audio).
 * Structure: a 13-word opening that carries the AI disclosure ("Hi Priya, I'm Daniel's AI assistant, not a person.
 * This call is recorded."), the inherited facts, the opt-out, then exactly one next step. Over the cap, the date
 * clause is dropped first, then the vehicle clause, then the premium clause. This is the parity oracle's greeting
 * (PLATFORM §4.6): `data/relays/baton-add-driver.json` reproduces it through the kernel.
 *
 * Invariant (asserted at runtime and property-tested): every value in the text belongs to a VERIFIED field,
 * except the single confirm clause, which carries one PENDING value.
 */
import type { CaseState, FieldId, FieldState, PolicyRecord } from "../contracts/case";
import type { NextStep } from "../contracts/takeover";
import {
  GREETING_PRIORITY, askPhrase, confirmPhrase, firstNameOf, vehicleLabelOf, type PhraseCtx,
} from "../intents/add-driver";
import { REQUIRED_SET } from "../intents/add-driver.fields";
import { spokenDate, spokenMonthly } from "./spoken";
import { nextStepOf } from "./stages";

/** Length cap (PLATFORM v2.1 lint G2; was 70): above this, drop the date clause, then the vehicle, then the premium. */
export const GREETING_MAX_WORDS = 40;
/** The opening (AI disclosure + recording notice) is at most this many words (PLATFORM §3.4 G2). */
export const GREETING_OPENING_MAX_WORDS = 14;

/** The mandatory disclosure checks (unit-tested): `/AI assistant/` ∧ `/not a person/` ∧ `/recorded/`. */
export const GREETING_DISCLOSURE_RES: readonly RegExp[] = [/AI assistant/, /not a person/, /recorded/];

/** Greeting clauses the length cap may drop, in drop order. */
export const GREETING_DROP_ORDER = ["date", "vehicle", "premium"] as const;
export type GreetingClause = (typeof GREETING_DROP_ORDER)[number];

export interface GreetingResult {
  text: string;
  wordCount: number;
  /** Fields whose (VERIFIED) values the text states outside the confirm clause. */
  asserted: FieldId[];
  /** The MISSING field the closing sentence asks for, if the next step is an ask. */
  asks: FieldId | null;
  /** The PENDING field the closing sentence confirms, if the next step is a confirm. */
  confirms: FieldId | null;
  /** The next step the greeting sets up (feeds `inputModeFor`). */
  nextStep: NextStep;
  /** Clauses dropped by the length cap, in order. */
  dropped: GreetingClause[];
}

export const wordsIn = (s: string): number => s.trim().split(/\s+/).filter(Boolean).length;
const fieldOf = (s: Pick<CaseState, "fields">, f: FieldId): FieldState | undefined => s.fields[f];
const verifiedValue = (s: Pick<CaseState, "fields">, f: FieldId): string | null => {
  const st = fieldOf(s, f);
  return st && st.status === "VERIFIED" && st.value !== null ? st.value : null;
};
const knownValue = (s: Pick<CaseState, "fields">, f: FieldId): string | null => {
  const st = fieldOf(s, f);
  return st && st.status !== "MISSING" && st.value !== null ? st.value : null;
};

/** The phrase context: `{d}` and the vehicle label come from VERIFIED values only. */
export function greetingPhraseCtx(snapshot: Pick<CaseState, "fields">, policy: PolicyRecord): PhraseCtx {
  const name = verifiedValue(snapshot, "driver_full_name");
  const veh = verifiedValue(snapshot, "vehicle_assignment");
  return { policy, d: name ? firstNameOf(name) : "the new driver", vehicleLabel: veh ? vehicleLabelOf(policy, veh) : null };
}

/** The opening: AI disclosure + recording notice in 13 words (PLATFORM §3.4 G2: ≤ 14). */
export const greetingOpening = (policy: PolicyRecord): string =>
  `Hi ${policy.policyholder.firstName}, I'm ${policy.repFirstName}'s AI assistant, not a person. This call is recorded.`;

/** The opt-out sentence. */
export const greetingOptOut = (policy: PolicyRecord): string => `Ask for ${policy.repFirstName} anytime.`;

/** The closing sentence for a next step (§5.6 sentence 4, shortened in v2.1). */
export function nextStepSentence(snapshot: Pick<CaseState, "fields">, step: NextStep, pc: PhraseCtx): string {
  if (step.kind === "confirm" && step.field) {
    const st = fieldOf(snapshot, step.field)!;
    return `Just to confirm, ${confirmPhrase(step.field, st.value!, { ...pc, raw: st.display })}?`;
  }
  if (step.kind === "ask" && step.field) return `I just need ${askPhrase(step.field, pc)}.`;
  return "Ready for the updated premium?";
}

/**
 * `compileGreeting(snapshot, policy)` (§5.6, v2.1): the opening; the hand-off summary with only VERIFIED clauses
 * (driver first name, vehicle, start date, and the premium only if the REP quoted it); the opt-out; exactly one next
 * step (confirm the first PENDING field in priority order, else ask the first required MISSING field, else "ready?").
 */
export function compileGreeting(snapshot: Pick<CaseState, "fields">, policy: PolicyRecord): GreetingResult {
  const pc = greetingPhraseCtx(snapshot, policy);
  const name = verifiedValue(snapshot, "driver_full_name");
  const veh = verifiedValue(snapshot, "vehicle_assignment");
  const date = verifiedValue(snapshot, "effective_date");
  const premiumState = fieldOf(snapshot, "premium_new_monthly_usd");
  const premium = premiumState?.status === "VERIFIED" && premiumState.source === "rep" ? premiumState.value : null;

  const step = nextStepOf(snapshot);
  const closing = nextStepSentence(snapshot, step, pc);
  const present: Record<GreetingClause, boolean> = { date: date !== null, vehicle: veh !== null, premium: premium !== null };
  const kept: Record<GreetingClause, boolean> = { date: true, vehicle: true, premium: true };

  const build = (): string => {
    const vehicleClause = kept.vehicle && veh ? (veh === "all" ? " to all your vehicles" : ` to the ${vehicleLabelOf(policy, veh)}`) : "";
    const dateClause = kept.date && date ? `, starting ${spokenDate(date)}` : "";
    const premiumClause = kept.premium && premium ? `, at ${spokenMonthly(premium)}` : "";
    const summary = `I'll finish adding ${name ? firstNameOf(name) : "a new driver"}${vehicleClause}${dateClause}${premiumClause}.`;
    return [greetingOpening(policy), summary, greetingOptOut(policy), closing].join(" ");
  };

  const dropped: GreetingClause[] = [];
  let text = build();
  for (const c of GREETING_DROP_ORDER) {
    if (wordsIn(text) <= GREETING_MAX_WORDS) break;
    if (!present[c]) continue;
    kept[c] = false;
    dropped.push(c);
    text = build();
  }

  // Clause-based: a field is asserted when its summary clause is in the text (the confirm sentence never counts).
  const asserted: FieldId[] = [];
  if (name) asserted.push("driver_full_name");
  if (veh && kept.vehicle) asserted.push("vehicle_assignment");
  if (date && kept.date) asserted.push("effective_date");
  if (premium && kept.premium) asserted.push("premium_new_monthly_usd");

  const result: GreetingResult = {
    text,
    wordCount: wordsIn(text),
    asserted,
    asks: step.kind === "ask" ? step.field : null,
    confirms: step.kind === "confirm" ? step.field : null,
    nextStep: step,
    dropped,
  };
  assertGreetingInvariant(result, snapshot);
  return result;
}

/** Throws if the greeting asserts a non-VERIFIED value or confirms a non-PENDING one (cannot happen by construction). */
export function assertGreetingInvariant(g: Pick<GreetingResult, "asserted" | "confirms" | "text">, snapshot: Pick<CaseState, "fields">): void {
  for (const f of g.asserted) {
    if (snapshot.fields[f]?.status !== "VERIFIED") throw new Error(`greeting invariant: asserted ${f} is not VERIFIED`);
  }
  if (g.confirms && snapshot.fields[g.confirms]?.status !== "PENDING") throw new Error(`greeting invariant: confirm field ${g.confirms} is not PENDING`);
  for (const re of GREETING_DISCLOSURE_RES) if (!re.test(g.text)) throw new Error(`greeting invariant: disclosure ${re} missing`);
}

/**
 * `compileGreetingV1` (the naive v1 pipeline, §6.4): asserts every KNOWN value (VERIFIED or PENDING) in the
 * summary plus a recap of the other known priority fields, then asks the first required MISSING field. Used only
 * by the sweep to show why v3's rules matter (cut with the sweep in v2.1; kept for its tests). No length cap.
 */
export function compileGreetingV1(snapshot: Pick<CaseState, "fields">, policy: PolicyRecord): GreetingResult {
  const name = knownValue(snapshot, "driver_full_name");
  const veh = knownValue(snapshot, "vehicle_assignment");
  const date = knownValue(snapshot, "effective_date");
  const premium = knownValue(snapshot, "premium_new_monthly_usd");
  const pc: PhraseCtx = { policy, d: name ? firstNameOf(name) : "the new driver", vehicleLabel: veh ? vehicleLabelOf(policy, veh) : null };
  const rep = policy.repFirstName;
  const asserted: FieldId[] = [];
  let summary = `${rep} passed me your request to add ${name ? firstNameOf(name) : "a new driver"}`;
  if (name) asserted.push("driver_full_name");
  if (veh) { summary += veh === "all" ? " as a driver on all your vehicles" : ` as a driver on the ${vehicleLabelOf(policy, veh)}`; asserted.push("vehicle_assignment"); }
  if (date) { summary += `, starting ${spokenDate(date)}`; asserted.push("effective_date"); }
  if (premium) { summary += `, at ${spokenMonthly(premium)}`; asserted.push("premium_new_monthly_usd"); }
  summary += ".";
  const recap: string[] = [];
  for (const f of GREETING_PRIORITY) {
    if (f === "driver_full_name" || f === "vehicle_assignment" || f === "effective_date") continue;
    const v = knownValue(snapshot, f);
    if (v === null) continue;
    recap.push(confirmPhrase(f, v, { ...pc, raw: fieldOf(snapshot, f)?.display ?? null }));
    asserted.push(f);
  }
  let ask: FieldId | null = null;
  for (const f of GREETING_PRIORITY) {
    if (REQUIRED_SET.has(f) && knownValue(snapshot, f) === null) { ask = f; break; }
  }
  const step: NextStep = ask ? { kind: "ask", field: ask } : { kind: "none", field: null };
  const parts = [greetingOpening(policy), summary];
  if (recap.length) parts.push(`I also have that ${recap.join("; ")}.`);
  parts.push(greetingOptOut(policy), nextStepSentence(snapshot, step, pc));
  const text = parts.join(" ");
  return { text, wordCount: wordsIn(text), asserted, asks: ask, confirms: null, nextStep: step, dropped: [] };
}
