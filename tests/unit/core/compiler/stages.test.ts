import { describe, expect, it } from "vitest";
import { TAKEOVER_TIMING, type CasePayment, type PhoneState } from "../../../../src/core/contracts";
import {
  DEFAULT_VA_CAP_ENV, HOLD_EXTEND_STATES, absoluteCeilingReached, advanceHoldDeadline, effectiveCapMs, holdTimedOut,
  initialHoldDeadlineMs, initialStage, inputModeFor, nextStage, nextStepOf, onPaymentSucceeded, openRequiredFields,
  reassuranceDue, staticInputMode, vaSessionCapMs, wrapUpDue,
} from "../../../../src/core/compiler/stages";
import { handoffStateOf, policyOf, stateOf } from "../case/_fixtures";

const s01 = policyOf("s01");

describe("inputModeFor (§5.9.1)", () => {
  it("balanced for MISSING entities, max_accuracy for license_number, min_latency for yes/no and disclosures", () => {
    for (const f of ["driver_dob", "garaging_zip", "license_state", "driver_full_name", "vehicle_assignment", "effective_date"] as const) {
      expect(inputModeFor({ kind: "ask", field: f })).toEqual({ mode: "balanced", reason: "asks_entity" });
    }
    expect(inputModeFor({ kind: "ask", field: "license_number" })).toEqual({ mode: "max_accuracy", reason: "id_capture" });
    expect(inputModeFor({ kind: "confirm", field: "effective_date" })).toEqual({ mode: "min_latency", reason: "yes_no" });
    expect(inputModeFor({ kind: "none", field: null })).toEqual({ mode: "min_latency", reason: "yes_no" });
    expect(inputModeFor({ kind: "disclosure", field: null })).toEqual({ mode: "min_latency", reason: "disclosure" });
    expect(inputModeFor({ kind: "consent", field: null })).toEqual({ mode: "min_latency", reason: "disclosure" });
  });

  it("staticInputMode (T-D1-4 fallback): balanced iff a required entity is MISSING", () => {
    expect(staticInputMode(handoffStateOf("s05")).mode).toBe("balanced");
    expect(staticInputMode(handoffStateOf("s02")).mode).toBe("min_latency");
    expect(staticInputMode(handoffStateOf("s01")).mode).toBe("min_latency");
  });
});

describe("stages (§5.8)", () => {
  it("initialStage: disclose if ready, else confirm", () => {
    expect(initialStage(handoffStateOf("s01"))).toBe("disclose");
    expect(initialStage(handoffStateOf("s02"))).toBe("confirm");
    expect(initialStage(handoffStateOf("s05"))).toBe("confirm");
  });

  it("nextStage is forward-only and can chain", () => {
    const ready = handoffStateOf("s01");
    const notReady = handoffStateOf("s02");
    const paid: CasePayment = { id: "p", status: "succeeded", amountCents: 100, totalAmountCents: 100, provider: "mock", simulated: true };
    expect(nextStage("confirm", notReady)).toBe("confirm");
    expect(nextStage(null, notReady)).toBe("confirm");
    expect(nextStage("confirm", ready)).toBe("disclose");
    expect(nextStage("disclose", { ...ready, disclosuresGiven: ["premium_change"] })).toBe("disclose");
    expect(nextStage("disclose", { ...ready, disclosuresGiven: ["premium_change", "esign_consent"] })).toBe("pay");
    expect(nextStage("pay", { ...ready, payment: { ...paid, status: "open" } })).toBe("pay");
    expect(nextStage("pay", { ...ready, payment: paid })).toBe("close");
    expect(nextStage("confirm", { ...ready, disclosuresGiven: ["esign_consent"], payment: paid })).toBe("close");
    expect(nextStage("close", notReady)).toBe("close"); // never backwards
  });

  it("nextStepOf: PENDING in priority order, then required MISSING (never the premium), else none", () => {
    expect(nextStepOf(handoffStateOf("s02"))).toEqual({ kind: "confirm", field: "effective_date" });
    expect(nextStepOf(handoffStateOf("s05"))).toEqual({ kind: "ask", field: "license_state" });
    expect(nextStepOf(handoffStateOf("s01"))).toEqual({ kind: "none", field: null });
    expect(nextStepOf(stateOf(s01, {}))).toEqual({ kind: "ask", field: "driver_full_name" });
    const noPremium = stateOf(s01, Object.fromEntries(Object.entries(handoffStateOf("s01").fields).filter(([f]) => f !== "premium_new_monthly_usd")
      .map(([f, st]) => [f, { status: st.status, value: st.value }])));
    expect(nextStepOf(noPremium)).toEqual({ kind: "none", field: null });
  });
});

describe("dynamic cap (§5.9.5)", () => {
  it("150 s + 15 s per open required field (premium excluded), at most 420 s", () => {
    expect(vaSessionCapMs(handoffStateOf("s01"), DEFAULT_VA_CAP_ENV)).toBe(150_000);
    expect(vaSessionCapMs(handoffStateOf("s02"), DEFAULT_VA_CAP_ENV)).toBe(165_000);
    expect(vaSessionCapMs(handoffStateOf("s05"), DEFAULT_VA_CAP_ENV)).toBe(165_000);
    expect(openRequiredFields(stateOf(s01, {}))).toHaveLength(9);
    expect(vaSessionCapMs(stateOf(s01, {}), DEFAULT_VA_CAP_ENV)).toBe(285_000);
    expect(vaSessionCapMs(stateOf(s01, {}), { baseMs: 150_000, perFieldMs: 40_000, maxMs: 420_000 })).toBe(420_000);
  });

  it("the wrap-up fires at effective cap − 20 s, pauses while paying, never in paying/closing, once", () => {
    const cap = 150_000;
    const at = (phase: Parameters<typeof wrapUpDue>[0]["phase"], elapsedMs: number, payingMs = 0, alreadySent = false) =>
      wrapUpDue({ phase, elapsedMs, capMs: cap, payingMs, alreadySent });
    expect(at("active", 129_999)).toBe(false);
    expect(at("active", 130_000)).toBe(true);
    expect(at("greeting", 130_000)).toBe(true);
    expect(at("paying", 200_000)).toBe(false);
    expect(at("closing", 200_000)).toBe(false);
    expect(at("done", 200_000)).toBe(false);
    expect(at("active", 130_000, 40_000)).toBe(false);
    expect(at("active", 170_000, 40_000)).toBe(true);
    expect(at("active", 300_000, 0, true)).toBe(false);
    expect(effectiveCapMs(cap, -5)).toBe(cap);
    expect(absoluteCeilingReached(599_999, DEFAULT_VA_CAP_ENV)).toBe(false);
    expect(absoluteCeilingReached(600_000, DEFAULT_VA_CAP_ENV)).toBe(true);
  });
});

describe("hold protocol timing (§5.8)", () => {
  const sms = 10_000;
  it("60 s deadline while the phone is only sms-received", () => {
    const d0 = initialHoldDeadlineMs(sms);
    expect(d0).toBe(70_000);
    expect(advanceHoldDeadline({ smsAtMs: sms, deadlineMs: d0, nowMs: 70_000, phone: "sms-received" })).toBe(70_000);
    expect(holdTimedOut({ smsAtMs: sms, deadlineMs: d0, nowMs: 69_999, phone: "sms-received" })).toBe(false);
    expect(holdTimedOut({ smsAtMs: sms, deadlineMs: d0, nowMs: 70_000, phone: "sms-received" })).toBe(true);
  });

  it("extends in 30 s steps only in the listed phone states, stopping at 180 s after the SMS", () => {
    const all: PhoneState[] = ["idle", "sms-received", "esign", "signed", "checkout-loading", "checkout-open", "processing", "simulating",
      "autopilot-countdown", "paid", "failed", "expired", "timeout"];
    for (const phone of all) {
      const d = advanceHoldDeadline({ smsAtMs: sms, deadlineMs: 70_000, nowMs: 70_000, phone });
      expect(d, phone).toBe(HOLD_EXTEND_STATES.has(phone) ? 100_000 : 70_000);
    }
    expect([...HOLD_EXTEND_STATES].sort()).toEqual(["checkout-loading", "checkout-open", "esign", "processing", "signed", "simulating"]);
    let d = initialHoldDeadlineMs(sms);
    for (let now = sms; now <= sms + 400_000; now += 1_000) d = advanceHoldDeadline({ smsAtMs: sms, deadlineMs: d, nowMs: now, phone: "processing" });
    expect(d).toBe(sms + TAKEOVER_TIMING.HOLD_MAX_MS);
    expect(holdTimedOut({ smsAtMs: sms, deadlineMs: d, nowMs: sms + 180_000, phone: "processing" })).toBe(true);
  });

  it("reassurance every 45 s, suppressed while the Polar overlay is open or processing", () => {
    expect(reassuranceDue({ smsAtMs: sms, nowMs: sms + 44_999, sentCount: 0, phone: "sms-received" })).toBe(false);
    expect(reassuranceDue({ smsAtMs: sms, nowMs: sms + 45_000, sentCount: 0, phone: "sms-received" })).toBe(true);
    expect(reassuranceDue({ smsAtMs: sms, nowMs: sms + 60_000, sentCount: 1, phone: "esign" })).toBe(false);
    expect(reassuranceDue({ smsAtMs: sms, nowMs: sms + 90_000, sentCount: 1, phone: "esign" })).toBe(true);
    expect(reassuranceDue({ smsAtMs: sms, nowMs: sms + 90_000, sentCount: 1, phone: "checkout-open" })).toBe(false);
    expect(reassuranceDue({ smsAtMs: sms, nowMs: sms + 90_000, sentCount: 1, phone: "processing" })).toBe(false);
  });

  it("a late success (after timeout) takes the push path", () => {
    expect(onPaymentSucceeded({ holdInFlight: true, sessionOpen: true })).toBe("tool_result");
    expect(onPaymentSucceeded({ holdInFlight: false, sessionOpen: true })).toBe("push_path");
    expect(onPaymentSucceeded({ holdInFlight: false, sessionOpen: false })).toBe("ignore");
  });
});
