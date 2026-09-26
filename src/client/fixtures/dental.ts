/**
 * client/fixtures/dental.ts - a second relay's console log (DEV FIXTURES).
 *
 * The Dental gallery relay (`data/relays/dental-deposit.json`, WP17) on a **simulated** call: different fields,
 * different groups, its own stage labels ("Deposit terms", "Deposit"), one disclosure and a phone that takes a
 * deposit with no e-sign step. Nothing in the console is Baton-shaped any more, so this log is the proof: the same
 * components render it from the run's `UiSpec` alone (PLATFORM §7.6, WP7 acceptance 3).
 *
 * `tests/unit/ui/ui-spec.test.ts` pins `DENTAL_UI_SPEC` against the real blueprint, so this fixture cannot drift
 * from the relay WP17 ships.
 */
import "client-only";

import type { CaseState, Evidence, FieldId, FieldState } from "@/core/contracts/case";
import type { UiCallContext, UiLogEntry } from "@/core/contracts/ext/wp7-ui";
import type { RunPlan } from "@/core/contracts/run";
import type { AccountRecord } from "@/core/contracts/v2/blueprint";
import type { UiSpec } from "@/core/contracts/v2/relay";

import { FixtureLog, syntheticPeaks, turnInput, type ScriptTurn } from "./builder";

export const DENTAL_CALL_ID = "sim_dental_deposit_fixture";
const CASE_ID = "case_fixture_dental";
const DURATION_MS = 98_000;
const DECISION_POINT_MS = 52_000;

/** The Dental relay's `UiSpec`, as the server compiles it (`compileRelay(dental-deposit.json).ui`). */
export const DENTAL_UI_SPEC: UiSpec = {
  relay: { id: "rel_dental_deposit", versionId: "rv_dental_3", slug: "dental-deposit", title: "Dental · booking deposit", flagship: false, simulated: true },
  fields: [
    { id: "patient_full_name", label: "Patient's full name", required: true, group: "Patient", hidden: false, type: "person_name", repOnly: false, advice: false },
    { id: "procedure", label: "Procedure", required: true, group: "Appointment", hidden: false, type: "enum", repOnly: false, advice: false },
    { id: "appointment_date", label: "Appointment date", required: true, group: "Appointment", hidden: false, type: "date", repOnly: false, advice: false },
    { id: "appointment_time", label: "Appointment time", required: true, group: "Appointment", hidden: false, type: "text", repOnly: false, advice: false },
    { id: "deposit_amount_usd", label: "Deposit", required: false, group: "Deposit", hidden: false, type: "money", repOnly: true, advice: false },
  ],
  stages: [
    { kind: "confirm", label: "Confirm" },
    { kind: "disclose", label: "Deposit terms" },
    { kind: "pay", label: "Deposit" },
    { kind: "close", label: "Close" },
  ],
  disclosures: [{ id: "deposit_terms", title: "Deposit terms" }],
  connectors: [
    { id: "deposit_link", type: "payment_link", label: "Deposit link" },
    { id: "confirmation", type: "confirmation", label: "Confirmation" },
  ],
  phone: { payment: true, esign: false, smsSender: "Cedar Hollow Dental" },
};

export const DENTAL_ACCOUNT: AccountRecord = {
  customer: { firstName: "Tomas", lastName: "Alvarez", phoneLast4: "7781" },
  org: { name: "Cedar Hollow Dental", repFirstName: "Nadia" },
  callDate: "2026-09-25",
  facts: { deposit_amount_usd: "50.00" },
  tables: {},
};

/** The one policy record the store still wants; a relay run's people come from the account above. */
const DENTAL_POLICY = {
  policyNumber: "—",
  carrier: "Cedar Hollow Dental",
  agencyName: "Cedar Hollow Dental",
  repFirstName: "Nadia",
  policyholder: { firstName: "Tomas", lastName: "Alvarez" },
  phoneOnFileLast4: "7781",
  address: { street: "18 Cedar Row", city: "Portland", state: "OR", zip: "97209" },
  vehicles: [],
  existingDrivers: [],
  discountsOnFile: [],
  callDate: "2026-09-25",
} as unknown as UiCallContext["policy"];

const TURNS: ScriptTurn[] = [
  { ch: "rep", startMs: 2_000, endMs: 8_400, text: "Cedar Hollow Dental, this is Nadia. I have you down for a crown fitting — can I take a couple of details?" },
  { ch: "customer", startMs: 9_000, endMs: 16_200, text: "Sure. It's Tomas Alvarez, and I think the appointment is the ninth of October." },
  { ch: "rep", startMs: 17_000, endMs: 25_600, text: "Thanks Tomas. Crown fitting on Friday the ninth of October at ten fifteen in the morning. There's a fifty dollar booking deposit." },
  { ch: "customer", startMs: 26_400, endMs: 30_100, text: "That works for me." },
  { ch: "rep", startMs: 46_000, endMs: 53_000, text: "I'll pass you to our assistant, who'll take the deposit and text you the link. Is that alright?" },
  { ch: "customer", startMs: 53_600, endMs: 55_800, text: "Yes, that's fine." },
];

const field = (id: string, status: FieldState["status"], value: string | null, display: string | null, evidence: Evidence[] = []): FieldState =>
  ({ field: id, status, reason: status === "VERIFIED" ? "stated_and_acknowledged" : "absent", value, display, source: status === "VERIFIED" ? "customer" : null, evidence, conflict: null, flags: [], updatedAtMs: 0 }) as unknown as FieldState;

/** The Dental case state: the relay's own field ids (widened at runtime; the contract enum is still Baton's). */
function dentalCase(verified: boolean): CaseState {
  const fields = {
    patient_full_name: field("patient_full_name", verified ? "VERIFIED" : "MISSING", verified ? "Tomas Alvarez" : null, verified ? "Tomas Alvarez" : null),
    procedure: field("procedure", verified ? "VERIFIED" : "MISSING", verified ? "crown_fitting" : null, verified ? "Crown fitting" : null),
    appointment_date: field("appointment_date", verified ? "VERIFIED" : "PENDING", verified ? "2026-10-09" : "2026-10-09", verified ? "Fri, Oct 9, 2026" : "Fri, Oct 9, 2026"),
    appointment_time: field("appointment_time", verified ? "VERIFIED" : "MISSING", verified ? "10:15" : null, verified ? "10:15 am" : null),
    deposit_amount_usd: field("deposit_amount_usd", "VERIFIED", "50.00", "$50.00"),
  } as unknown as CaseState["fields"];
  const v = verified ? 4 : 0;
  return {
    caseId: CASE_ID,
    intent: "book_deposit",
    version: verified ? 6 : 1,
    callClockMs: verified ? 30_100 : 8_400,
    fields,
    readiness: { verified: v, pending: verified ? 0 : 1, missing: 4 - v - (verified ? 0 : 1), requiredTotal: 4, ready: verified },
    conflicts: [],
    stage: null,
    disclosuresGiven: [],
    payment: null,
    confirmationNumber: null,
  } as unknown as CaseState;
}

export function dentalContext(): UiCallContext {
  return {
    callId: DENTAL_CALL_ID,
    title: "Booking deposit · Nadia ↔ Tomas · simulated call",
    callDate: "2026-09-25",
    durationMs: DURATION_MS,
    source: "twilio8k",
    language: "en",
    decisionPointMs: DECISION_POINT_MS,
    handoff: { lineStartMs: 46_000, lineEndMs: 53_000, acceptStartMs: 53_600, acceptEndMs: 55_800, declined: false },
    hasRecordedAiBundle: false,
    policy: DENTAL_POLICY,
    peaks: syntheticPeaks(TURNS, DURATION_MS),
    sttOpensPerMin: 5,
  };
}

/** The Dental relay's simulated run, from the pre-flight card to the verified QA card. */
export function buildDental(o: { stopAtMs?: number } = {}): UiLogEntry[] {
  const L = new FixtureLog();
  const CLICK_T = 2_400;
  const callStartT = CLICK_T + 1_200;
  const T = (callMs: number) => callStartT + callMs;
  const plan: RunPlan = {
    runId: "run_fixture_dental",
    caseId: CASE_ID,
    sttHalf: "live",
    aiHalf: "live",
    vaHoldId: "hold_fixture_dental",
    holdExpiresAt: "2026-09-25T18:00:00.000Z",
    reason: null,
    recordedHandoffMs: null,
  };

  L.add(0, { type: "ui.context", context: dentalContext() });
  L.add(10, {
    type: "ui.relay",
    relay: DENTAL_UI_SPEC,
    provenance: {
      humanHalf: "simulated",
      transcription: { kind: "live", date: null },
      aiHalf: { kind: "live", date: null },
      customerInAiHalf: "synthetic",
      detail: "Simulated audio: script by gpt-6-luna, voices by gpt-4o-mini-tts. Fictional people.",
    },
    account: DENTAL_ACCOUNT,
  });
  L.add(300, { type: "call.loaded", callId: DENTAL_CALL_ID, durationMs: DURATION_MS });
  L.add(400, { type: "run.plan", plan });
  L.add(410, { type: "ui.autopilot", on: true });
  L.add(CLICK_T, { type: "ui.start", kind: "full", startOffsetMs: 0 });
  for (const ch of ["rep", "customer"] as const) L.add(CLICK_T + 200, { type: "stt.status", channel: ch, status: "connecting" });
  L.add(CLICK_T + 1_000, { type: "stt.status", channel: "rep", status: "open", detail: "Begin 0f1c…" });
  L.add(CLICK_T + 1_050, { type: "stt.status", channel: "customer", status: "open", detail: "Begin 7b2a…" });

  const stop = o.stopAtMs ?? Infinity;
  const order = { rep: 0, customer: 0 };
  for (const t of TURNS) {
    if (t.startMs >= stop) return L.entries();
    const turn = turnInput(CASE_ID, t, order[t.ch]++);
    L.add(T(turn.recvMs), { type: "stt.final", turn });
  }
  L.add(T(8_600), { type: "case.state", state: dentalCase(false) });
  L.add(T(30_300), { type: "case.state", state: dentalCase(true) });
  for (let ms = 0; ms <= 56_000; ms += 1_000) L.add(T(ms), { type: "ui.clock", callMs: ms, playing: true });
  if (stop !== Infinity) return L.entries();

  // ---------------------------------------------------------------- the pass
  const A = T(55_800);
  L.add(A, { type: "takeover.phase", phase: "armed", atMs: 55_800, detail: { source: "auto_handoff", midUtterance: 0 } });
  L.add(A, { type: "ui.clock", callMs: 55_800, playing: false });
  L.add(A + 20, { type: "va.status", status: "connecting" });
  L.add(A + 140, { type: "takeover.phase", phase: "sealing", atMs: 55_940 });
  L.add(A + 400, { type: "takeover.phase", phase: "draining", atMs: 56_200 });
  L.add(A + 880, { type: "takeover.phase", phase: "compiling", atMs: 56_680 });
  L.add(A + 1_320, { type: "takeover.phase", phase: "connecting", atMs: 57_120 });
  L.add(A + 1_760, { type: "va.status", status: "ready", sessionId: "va_fixture_dental" });
  L.add(A + 1_800, { type: "takeover.phase", phase: "greeting", atMs: 57_600, detail: { leadMs: 820 } });
  L.add(A + 1_800, { type: "stage", stage: "confirm" });

  // ---------------------------------------------------------------- the AI half
  const say = (id: string, at: number, text: string, kind: "speech" | "tool_preamble" = "speech"): number => {
    const dur = Math.max(1_600, text.split(/\s+/).length * 290);
    L.add(at - 400, { type: "va.reply", replyId: id, phase: "started" });
    L.add(at, { type: "va.reply", replyId: id, phase: "first_audible" });
    L.add(at + 40, { type: "va.caption", replyId: id, words: text.split(/\s+/).map((w, i, xs) => ({ text: w, atMs: Math.round((i * dur) / xs.length) })) });
    L.add(at + dur + 300, { type: "va.reply", replyId: id, phase: "done", kind });
    return at + dur + 300;
  };
  const user = (at: number, text: string) => {
    L.add(at - 600, { type: "va.user", text: text.split(" ").slice(0, 2).join(" "), final: false });
    L.add(at, { type: "va.user", text, final: true });
  };

  const first = A + 2_400;
  L.add(first, { type: "takeover.phase", phase: "active", atMs: 0 });
  L.add(first + 40, { type: "hud", metric: "click_to_first_audible", ms: first - A });
  L.add(first + 40, { type: "hud", metric: "dead_air_after_rep", ms: 980 });
  let t = say("d1", first, "Hi Tomas, it's the assistant at Cedar Hollow Dental. I have a crown fitting on Friday, October ninth at ten fifteen, and a fifty dollar booking deposit. Shall I take that now?");

  const eos1 = t + 1_400;
  user(eos1, "Yes, go ahead.");
  L.add(eos1 + 150, { type: "va.reply", replyId: "d2", phase: "started" });
  L.add(eos1 + 300, { type: "va.tool", callId: "dt1", name: "get_disclosure", phase: "call", args: { kind: "deposit_terms" } });
  L.add(eos1 + 520, {
    type: "va.tool",
    callId: "dt1",
    name: "get_disclosure",
    phase: "result",
    args: { kind: "deposit_terms" },
    result: { kind: "deposit_terms", text: "The fifty dollar deposit is taken off your treatment cost and is refundable up to twenty-four hours before your appointment.", must_read_verbatim: true },
  });
  L.add(eos1 + 560, { type: "stage", stage: "disclose" });
  L.add(eos1 + 600, { type: "va.reply", replyId: "d2", phase: "done", kind: "tool_preamble" });
  t = say("d2b", eos1 + 1_400, "The fifty dollar deposit is taken off your treatment cost and is refundable up to twenty-four hours before your appointment.");

  // Deposit stage: the link, the payment, the webhook.
  const eos2 = t + 1_200;
  user(eos2, "That's fine, send me the link.");
  const payT = eos2 + 700;
  L.add(payT, { type: "va.reply", replyId: "d3", phase: "started" });
  L.add(payT + 100, { type: "va.tool", callId: "dt2", name: "send_esign_and_pay_link", phase: "call", args: { customer_agreed_to_text: true, customer_words: "That's fine, send me the link." } });
  L.add(payT + 250, { type: "stage", stage: "pay" });
  L.add(payT + 260, { type: "takeover.phase", phase: "paying", atMs: 0 });
  L.add(payT + 300, { type: "payment", status: "created" });
  L.add(payT + 400, { type: "phone.sms", text: "Cedar Hollow Dental: your $50.00 booking deposit for Fri 9 Oct, 10:15 am: https://changeover.example/pay/dep_fixture_1", link: "/pay/dep_fixture_1" });
  L.add(payT + 420, { type: "phone.state", state: "sms-received" });
  L.add(payT + 430, { type: "va.reply", replyId: "d3", phase: "done", kind: "tool_preamble" });
  t = say("d3b", payT + 1_500, "I've texted you the deposit link. Tap it when you're ready and I'll confirm.");
  const p0 = t + 1_200;
  L.add(p0, { type: "phone.state", state: "checkout-loading" });
  L.add(p0 + 900, { type: "payment", status: "open" });
  L.add(p0 + 1_400, { type: "phone.state", state: "checkout-open" });
  L.add(p0 + 5_200, { type: "phone.state", state: "processing" });
  L.add(p0 + 7_300, { type: "payment", status: "succeeded", source: "webhook" });
  L.add(p0 + 7_400, { type: "phone.state", state: "paid" });
  L.add(p0 + 7_500, {
    type: "va.tool",
    callId: "dt3",
    name: "send_esign_and_pay_link",
    phase: "result",
    args: { customer_agreed_to_text: true },
    result: { status: "paid", amount: "$50.00", next_step: "Confirm the appointment and close." },
  });
  L.add(p0 + 7_600, { type: "stage", stage: "close" });
  t = say("d4", p0 + 8_200, "That's paid, thank you. You're booked for Friday, October ninth at ten fifteen. You'll get a text confirmation in a moment.");
  L.add(t + 200, { type: "va.tool", callId: "dt4", name: "send_confirmation", phase: "call", args: { channel: "sms" } });
  L.add(t + 500, { type: "va.tool", callId: "dt4", name: "send_confirmation", phase: "result", args: { channel: "sms" }, result: { status: "sent", confirmation_number: "CH-40912" } });
  L.add(t + 700, { type: "phone.sms", text: "Cedar Hollow Dental: booking CH-40912 confirmed — Fri 9 Oct, 10:15 am. Deposit $50.00 received." });
  L.add(t + 1_200, { type: "takeover.phase", phase: "closing", atMs: 0 });
  L.add(t + 2_400, { type: "va.status", status: "ended" });
  L.add(t + 2_500, { type: "takeover.phase", phase: "done", atMs: 0, detail: { outcome: "completed" } });

  const qa = (provisional: boolean) => ({
    provisional,
    reAsked: 0,
    newlyAsked: 0,
    pendingConfirmed: 1,
    verifiedReconfirmed: 3,
    disclosures: [{ kind: "deposit_terms", similarity: provisional ? 0.99 : 0.98, ok: true, missingCritical: [] }],
    clickToFirstAudibleMs: 2_400,
    deadAirAfterRepMs: 980,
    turnLatencyP50Ms: 2_200,
    payment: "verified_webhook",
    handedBack: false,
    aiSeconds: 74,
    adviceFlags: 0,
    details: [
      { sentence: "I have a crown fitting on Friday, October ninth at ten fifteen, and a fifty dollar booking deposit.", atMs: 2_900, field: "appointment_date", classification: "pending_confirm" },
      { sentence: "That's paid, thank you. You're booked for Friday, October ninth at ten fifteen.", atMs: 71_200, field: null, classification: "other" },
    ],
  });
  L.add(t + 2_700, { type: "qa", qa: qa(true) as never });
  L.add(t + 18_200, { type: "qa", qa: qa(false) as never });
  return L.entries();
}
