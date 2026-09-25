/**
 * compiler/greeting.ts - the deterministic greeting compiler (DESIGN §5.6). No LLM is involved.
 * WP1 early deliverable (WP5 compile, WP9b sweep).
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

/** §5.6 length cap: above this, drop the date clause, then the vehicle clause. */
export const GREETING_MAX_WORDS = 70;

/** The mandatory disclosure checks (unit-tested): `/AI assistant/` ∧ `/not a person/` ∧ `/recorded/`. */
export const GREETING_DISCLOSURE_RES: readonly RegExp[] = [/AI assistant/, /not a person/, /recorded/];

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
  dropped: ("date" | "vehicle")[];
}

const wordsIn = (s: string): number => s.trim().split(/\s+/).filter(Boolean).length;
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

const disclosureSentence = (policy: PolicyRecord): string =>
  `Hi ${policy.policyholder.firstName}, this is ${policy.agencyName}'s AI assistant. I'm an automated assistant, not a person, and this call is still being recorded.`;

/** The closing sentence for a next step (§5.6 sentence 4). */
export function nextStepSentence(snapshot: Pick<CaseState, "fields">, step: NextStep, pc: PhraseCtx): string {
  if (step.kind === "confirm" && step.field) {
    const st = fieldOf(snapshot, step.field)!;
    return `Just to confirm, ${confirmPhrase(step.field, st.value!, { ...pc, raw: st.display })}. Is that right?`;
  }
  if (step.kind === "ask" && step.field) return `To finish up, I just need ${askPhrase(step.field, pc)}.`;
  return "I have everything I need, so next I'll read you the updated premium. Ready?";
}

/**
 * `compileGreeting(snapshot, policy)` (§5.6): disclosure; hand-off summary with only VERIFIED clauses (driver
 * first name, vehicle, start date, and the premium only if the REP quoted it); the opt-out; exactly one next step
 * (confirm the first PENDING field in priority order, else ask the first required MISSING field, else "ready?").
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
  const rep = policy.repFirstName;

  const build = (withVehicle: boolean, withDate: boolean): string => {
    // "add Maya as a driver on the …"; without a verified name, "add a new driver on the …" (not "a new driver as a driver").
    const lead = name ? " as a driver" : "";
    const vehicleClause = withVehicle && veh ? (veh === "all" ? `${lead} on all your vehicles` : `${lead} on the ${vehicleLabelOf(policy, veh)}`) : "";
    const dateClause = withDate && date ? `, starting ${spokenDate(date)}` : "";
    const premiumClause = premium ? `, at ${spokenMonthly(premium)}` : "";
    const summary = `${rep} passed me your request to add ${name ? firstNameOf(name) : "a new driver"}${vehicleClause}${dateClause}${premiumClause}.`;
    return [disclosureSentence(policy), summary, `You can ask for ${rep} at any time.`, closing].join(" ");
  };

  const dropped: ("date" | "vehicle")[] = [];
  let withVehicle = true;
  let withDate = true;
  let text = build(withVehicle, withDate);
  if (wordsIn(text) > GREETING_MAX_WORDS && date) { withDate = false; dropped.push("date"); text = build(withVehicle, withDate); }
  if (wordsIn(text) > GREETING_MAX_WORDS && veh) { withVehicle = false; dropped.push("vehicle"); text = build(withVehicle, withDate); }

  const asserted: FieldId[] = [];
  if (name && text.includes(firstNameOf(name))) asserted.push("driver_full_name");
  if (veh && text.includes(vehicleLabelOf(policy, veh))) asserted.push("vehicle_assignment");
  if (date && withDate) asserted.push("effective_date");
  if (premium) asserted.push("premium_new_monthly_usd");

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
 * by the sweep to show why v3's rules matter. `asserted` lists every field whose value it states.
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
  const parts = [disclosureSentence(policy), summary];
  if (recap.length) parts.push(`I also have that ${recap.join("; ")}.`);
  parts.push(`You can ask for ${rep} at any time.`, nextStepSentence(snapshot, step, pc));
  const text = parts.join(" ");
  return { text, wordCount: wordsIn(text), asserted, asks: ask, confirms: null, nextStep: step, dropped: [] };
}
