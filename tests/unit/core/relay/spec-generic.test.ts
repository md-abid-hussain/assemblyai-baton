/**
 * Spec injection on a GENERIC relay (WP14a·3): the WP1 core functions run the mini dental relay (tests fixture) when
 * given its compiled spec. Until the P§4.7 widening, a relay's `AccountRecord` travels through the unchanged
 * `PolicyRecord` parameter (the functions read it through `accountFor`).
 */
import { describe, expect, it } from "vitest";
import type { NewFactEvent, PolicyRecord, RawPatch, TurnInput } from "@/core/contracts";
import { applyExtraction } from "@/core/case/apply";
import { deriveCaseState } from "@/core/case/derive";
import { emptyCaseState } from "@/core/case/state";
import { caseStateJson } from "@/core/compiler/prompt";
import { disclosureText } from "@/core/compiler/disclosures";
import { inputModeFor, nextStepOf, openRequiredFields, vaSessionCapMs } from "@/core/compiler/stages";
import { suggestReplies } from "@/core/compiler/suggest";
import { buildSttParams } from "@/core/aai/stt-params";
import { computeQa } from "@/core/qa";
import { classifySentence, isAdvice } from "@/core/qa/reask";
import { compileRelay } from "@/core/relay/compile";
import { miniBlueprint } from "./fixtures/mini-blueprint";

const bp = miniBlueprint();
const k = compileRelay(bp);
const spec = k.spec;
const account = bp.context.samples[0]!;
const asPolicy = account as unknown as PolicyRecord;   // until the P§4.7 widening
const caseId = "case_mini";

function turn(i: number, channel: "rep" | "customer", text: string): TurnInput {
  const startMs = i * 3000;
  const words = text.split(/\s+/).map((w, j) => ({ text: w, startMs: startMs + j * 200, endMs: startMs + j * 200 + 180, confidence: 0.9 }));
  return { caseId, turnId: `t${i}`, channel, text, startMs, endMs: words.at(-1)!.endMs, words, source: "stt_live", recvMs: startMs + 2500, cut: false, late: false };
}

const TURNS = [
  turn(0, "customer", "It's for Maya Ortiz."),
  turn(1, "rep", "Maya Ortiz, got it."),
  turn(2, "rep", "We have you on October 2nd."),
  turn(3, "customer", "A cleaning please."),
  turn(4, "customer", "My driver is Sam."),
  turn(5, "customer", "I've been here before."),
  turn(6, "rep", "Returning patient, great."),
];
const PATCH = {
  no_facts: false,
  events: [
    { turn_id: "t0", field: "patient_name", kind: "stated", value: "Maya Ortiz", quote: "Maya Ortiz", acknowledges_turn_id: null, confidence: "high" },
    { turn_id: "t1", field: "patient_name", kind: "readback", value: "Maya Ortiz", quote: "Maya Ortiz", acknowledges_turn_id: null, confidence: "high" },
    { turn_id: "t2", field: "appointment_date", kind: "stated", value: "October 2nd", quote: "October 2nd", acknowledges_turn_id: null, confidence: "high" },
    { turn_id: "t3", field: "treatment", kind: "stated", value: "cleaning", quote: "A cleaning", acknowledges_turn_id: null, confidence: "high" },
    { turn_id: "t4", field: "driver_full_name", kind: "stated", value: "Sam", quote: "Sam", acknowledges_turn_id: null, confidence: "high" },
    { turn_id: "t5", field: "visit_kind", kind: "stated", value: "I've been here before", quote: "been here before", acknowledges_turn_id: null, confidence: "high" },
    { turn_id: "t6", field: "visit_kind", kind: "readback", value: "returning", quote: "Returning patient", acknowledges_turn_id: null, confidence: "high" },
  ],
} as unknown as RawPatch;

const events = (): NewFactEvent[] => applyExtraction(PATCH, TURNS, { caseId, policy: asPolicy }, spec);

describe("WP1 core functions on the mini dental relay (compiled spec)", () => {
  it("applyExtraction normalizes through the spec and drops fields the relay does not have", () => {
    const evs = events();
    expect(evs.map((e) => e.field)).toEqual(["patient_name", "patient_name", "appointment_date", "treatment", "visit_kind", "visit_kind"]);
    expect(evs.map((e) => e.valueNorm)).toEqual(["maya ortiz", "maya ortiz", "2026-10-02", "cleaning", "returning", "returning"]);
  });

  it("deriveCaseState: the relay's fields, rep-only rule, readiness and next step", () => {
    const st = deriveCaseState(asPolicy, events().map((e, i) => ({ ...e, seq: i + 1 })), { caseId }, spec);
    expect(Object.keys(st.fields)).toEqual(["patient_name", "appointment_date", "treatment", "visit_kind"]);
    const f = st.fields as unknown as Record<string, { status: string; reason: string; display: string | null }>;
    expect(f.patient_name).toMatchObject({ status: "VERIFIED", reason: "read_back", display: "Maya Ortiz" });
    expect(f.appointment_date).toMatchObject({ status: "PENDING", reason: "stated_once" });
    expect(f.treatment).toMatchObject({ status: "PENDING", reason: "rep_only_violation", display: "Cleaning" });
    expect(f.visit_kind).toMatchObject({ status: "VERIFIED", reason: "read_back" });
    expect(st.readiness).toEqual({ verified: 1, pending: 2, missing: 0, requiredTotal: 3, ready: false });
    expect(nextStepOf(st, spec)).toEqual({ kind: "confirm", field: "appointment_date" as never });
    expect(openRequiredFields(st, spec)).toEqual(["appointment_date", "treatment"]);
    expect(vaSessionCapMs(st, { baseMs: 120_000, perFieldMs: 15_000, maxMs: 180_000 }, spec)).toBe(150_000);
    expect(inputModeFor({ kind: "ask", field: "patient_name" as never }, spec)).toEqual({ mode: "balanced", reason: "asks_entity" });
  });

  it("an appointment outside the 0–90 day window is PENDING out_of_range (validation from the blueprint)", () => {
    const patch = { no_facts: false, events: [
      { turn_id: "t2", field: "appointment_date", kind: "stated", value: "2027-06-01", quote: "x", acknowledges_turn_id: null, confidence: "high" },
      { turn_id: "t3", field: "appointment_date", kind: "stated", value: "2027-06-01", quote: "x", acknowledges_turn_id: null, confidence: "high" },
    ] } as unknown as RawPatch;
    const evs = applyExtraction(patch, TURNS, { caseId, policy: asPolicy }, spec).map((e, i) => ({ ...e, seq: i + 1 }));
    const st = deriveCaseState(asPolicy, evs, { caseId }, spec);
    expect((st.fields as unknown as Record<string, { status: string; reason: string; flags: string[] }>).appointment_date)
      .toMatchObject({ status: "PENDING", reason: "out_of_range", flags: ["out_of_range"] });
  });

  it("caseStateJson, disclosureText and buildSttParams come from the compiled relay", () => {
    const st = deriveCaseState(asPolicy, events().map((e, i) => ({ ...e, seq: i + 1 })), { caseId }, spec);
    expect(caseStateJson(st, asPolicy, spec)).toBe(k.caseJson(st, account));
    expect(JSON.parse(caseStateJson(st, asPolicy, spec))).toMatchObject({ intent: "book_deposit", clinic: "Brightwater Dental" });
    const d = disclosureText("deposit_terms" as never, { snapshot: st, policy: asPolicy, monthlyUsd: "0.00", dueTodayUsd: "0.00" }, {}, spec);
    expect(d).toEqual(k.disclosure("deposit_terms", { snapshot: st, account, opts: { taxSuffix: false } }));
    const p = buildSttParams({ format: { encoding: "pcm_mulaw", sampleRate: 8000, channels: 2 } as never, language: "en", scenarioId: "sim" }, asPolicy, "customer", {}, spec);
    expect(p.keyterms_prompt).toEqual(k.listening(account).keyterms);
    expect(p.prompt).toBe(bp.listening.scenarioPrompt);
    expect(p.min_turn_silence).toBe(160);
  });

  it("QA: the relay's lexicon, advice patterns and spoken forms", () => {
    const st = deriveCaseState(asPolicy, events().map((e, i) => ({ ...e, seq: i + 1 })), { caseId }, spec);
    expect(classifySentence("Could you confirm the patient's full name?", st, asPolicy, spec).fields).toEqual([{ field: "patient_name", classification: "reask" }]);
    expect(classifySentence("Is the appointment for Maya Ortiz, the patient's name?", st, asPolicy, spec).fields).toEqual([{ field: "patient_name", classification: "verified_reconfirm" }]);
    expect(classifySentence("Which day works for you?", st, asPolicy, spec).fields).toEqual([{ field: "appointment_date", classification: "pending_confirm" }]);
    expect(isAdvice("I recommend whitening too.", spec)).toBe(true);
    expect(isAdvice("I recommend whitening too.")).toBe(true);   // the legacy lexicon happens to match too
    expect(isAdvice("Consider higher deductibles.", spec)).toBe(false);
    expect(isAdvice("Consider higher deductibles.")).toBe(true);
    const qa = computeQa({
      provisional: true, snapshot: st, policy: asPolicy, toolCalls: [], disclosures: [], greeting: "", payment: "unpaid", handedBack: false, aiSeconds: 30,
      ch2: [{ text: "Could you confirm the patient's full name? You should get whitening.", startMs: 0 }],
    }, spec);
    expect(qa).toMatchObject({ reAsked: 1, adviceFlags: 1 });
  });

  it("suggestReplies: the generic engine (consent disclosure, open asks, confirms, the rep's name)", () => {
    const st = emptyCaseState(caseId, spec);
    const truth = { patient_name: "maya ortiz", appointment_date: "2026-10-02", treatment: "cleaning" } as never;
    const ctx = (lastAgentText: string, stage: "confirm" | "disclose" = "confirm") =>
      ({ lastAgentText, snapshot: st, truth, stage, paymentStatus: null, policy: asPolicy });
    const texts = (t: string, stage?: "confirm" | "disclose") => suggestReplies(ctx(t, stage), spec).map((s) => s.text);
    const deposit = k.disclosure("deposit_terms", { snapshot: st, account, opts: { taxSuffix: false } }).text;
    expect(texts(deposit, "disclose")).toEqual(["Yes, please text me the link.", "Can I talk to Sam?", "Sorry, could you repeat that?"]);
    expect(texts("Could you tell me the patient's full name?")[0]).toBe("It's Maya Ortiz.");
    expect(texts("Is the appointment for Maya Ortiz, the patient's name?")[0]).toBe("Yes, that's right.");
    expect(texts("Just to confirm, which day, October 3rd?")[0]).toBe("No, it's Friday, October 2nd.");
    expect(texts("Great, thanks.")).toEqual(["Okay.", "Sure.", "Can I talk to Sam?", "Sorry, could you repeat that?"]);
    const loop = suggestReplies({ ...ctx("Sorry, what's the patient's full name?"), history: ["What's the patient's name?"] }, spec);
    expect(loop[0]!.text).toBe("The appointment is for Maya Ortiz.");
  });
});
