import { describe, expect, it } from "vitest";
import type { FieldId, VerifierResult } from "../../../../src/core/contracts";
import { CaseStateSchema } from "../../../../src/core/contracts";
import { deriveCaseState, deriveV1, sortEvents } from "../../../../src/core/case/derive";
import { verifierDisagrees, verifierViewOf, type DerivableEvent } from "../../../../src/core/case/status-rules";
import { policyOf } from "./_fixtures";
import { ev } from "./_events";

const policy = policyOf("s01");
const derive = (events: DerivableEvent[], ctx: Partial<Parameters<typeof deriveCaseState>[2]> = {}) =>
  deriveCaseState(policy, events, { caseId: "c1", ...ctx });
const field = (events: DerivableEvent[], f: FieldId, ctx: Partial<Parameters<typeof deriveCaseState>[2]> = {}) => derive(events, ctx).fields[f];

const ZIP = "garaging_zip" as const;

describe("deriveField status rules (DESIGN §5.4.2, table)", () => {
  it("stated once → PENDING (stated_once)", () => {
    const f = field([ev({ field: ZIP, kind: "stated", party: "customer", value: "44107", t: 1000 })], ZIP);
    expect([f.status, f.reason, f.value, f.source]).toEqual(["PENDING", "stated_once", "44107", "customer"]);
  });

  it("stated + ack by the other party → VERIFIED (acknowledged)", () => {
    const s = ev({ field: ZIP, kind: "stated", party: "customer", value: "44107", t: 1000 });
    const f = field([s, ev({ field: ZIP, kind: "ack", party: "rep", value: null, t: 2000, ack: s.turnId })], ZIP);
    expect([f.status, f.reason]).toEqual(["VERIFIED", "acknowledged"]);
  });

  it("ack by the same party → PENDING", () => {
    const f = field([
      ev({ field: ZIP, kind: "stated", party: "customer", value: "44107", t: 1000 }),
      ev({ field: ZIP, kind: "ack", party: "customer", value: "44107", t: 2000 }),
    ], ZIP);
    expect([f.status, f.reason]).toEqual(["PENDING", "stated_once"]);
  });

  it("an ack of another turn or with an incompatible value does not confirm", () => {
    const s = ev({ field: ZIP, kind: "stated", party: "customer", value: "44107", t: 1000 });
    expect(field([s, ev({ field: ZIP, kind: "ack", party: "rep", t: 2000, ack: "customer-999" })], ZIP).status).toBe("PENDING");
    expect(field([s, ev({ field: ZIP, kind: "ack", party: "rep", value: "44108", t: 2000 })], ZIP).status).toBe("PENDING");
    expect(field([ev({ field: ZIP, kind: "ack", party: "rep", t: 500 }), s], ZIP).status).toBe("PENDING");
  });

  it("readback by the other party (same value) → VERIFIED (read_back); both stated → both_stated", () => {
    const f = field([
      ev({ field: ZIP, kind: "stated", party: "customer", value: "44107", t: 1000 }),
      ev({ field: ZIP, kind: "readback", party: "rep", value: "44107", t: 2000 }),
    ], ZIP);
    expect([f.status, f.reason]).toEqual(["VERIFIED", "read_back"]);
    const g = field([
      ev({ field: ZIP, kind: "stated", party: "rep", value: "44107", t: 1000 }),
      ev({ field: ZIP, kind: "stated", party: "customer", value: "44107", t: 2000 }),
    ], ZIP);
    expect([g.status, g.reason]).toEqual(["VERIFIED", "both_stated"]);
  });

  it("name subset read-back verifies and keeps the longer value", () => {
    const f = field([
      ev({ field: "driver_full_name", kind: "stated", party: "customer", value: "maya", t: 1000 }),
      ev({ field: "driver_full_name", kind: "readback", party: "rep", value: "maya raman", t: 2000 }),
    ], "driver_full_name");
    expect([f.status, f.value, f.display]).toEqual(["VERIFIED", "maya raman", "Maya Raman"]);
  });

  it("conflict → PENDING + conflict card; a later ack does not clear it", () => {
    const st = derive([
      ev({ field: ZIP, kind: "stated", party: "customer", value: "44107", t: 1000 }),
      ev({ field: ZIP, kind: "stated", party: "rep", value: "44108", t: 2000 }),
      ev({ field: ZIP, kind: "ack", party: "customer", value: null, t: 3000 }),
    ]);
    const f = st.fields[ZIP];
    expect([f.status, f.reason, f.value]).toEqual(["PENDING", "conflict", "44108"]);
    expect(f.conflict?.values).toEqual(["44107", "44108"]);
    expect(st.conflicts).toHaveLength(1);
    expect(st.conflicts[0]).toMatchObject({ field: ZIP, resolved: false, values: [{ value: "44107", party: "customer" }, { value: "44108", party: "rep" }] });
  });

  it("a different value against a CONFIRMED value by the other party → conflict, keeps the confirmed value", () => {
    const s = ev({ field: ZIP, kind: "stated", party: "customer", value: "44107", t: 1000 });
    const f = field([
      s,
      ev({ field: ZIP, kind: "ack", party: "rep", t: 2000, ack: s.turnId }),
      ev({ field: ZIP, kind: "stated", party: "rep", value: "44108", t: 3000 }),
    ], ZIP);
    expect([f.status, f.reason, f.value]).toEqual(["PENDING", "conflict", "44107"]);
  });

  it("corrected → the new value, conflict cleared (and the same party restating replaces)", () => {
    const f = field([
      ev({ field: ZIP, kind: "stated", party: "customer", value: "44107", t: 1000 }),
      ev({ field: ZIP, kind: "stated", party: "rep", value: "44108", t: 2000 }),
      ev({ field: ZIP, kind: "corrected", party: "customer", value: "44109", t: 3000 }),
      ev({ field: ZIP, kind: "readback", party: "rep", value: "44109", t: 4000 }),
    ], ZIP);
    expect([f.status, f.reason, f.value, f.conflict]).toEqual(["VERIFIED", "read_back", "44109", null]);
    const g = field([
      ev({ field: ZIP, kind: "stated", party: "customer", value: "44107", t: 1000 }),
      ev({ field: ZIP, kind: "stated", party: "customer", value: "44108", t: 2000 }),
    ], ZIP);
    expect([g.status, g.value]).toEqual(["PENDING", "44108"]);
  });

  it("denied → PENDING (denied); a same-party denial is ignored", () => {
    const s = ev({ field: ZIP, kind: "stated", party: "customer", value: "44107", t: 1000 });
    const a = ev({ field: ZIP, kind: "ack", party: "rep", t: 2000, ack: s.turnId });
    expect(field([s, a, ev({ field: ZIP, kind: "denied", party: "rep", t: 3000 })], ZIP)).toMatchObject({ status: "PENDING", reason: "denied" });
    expect(field([s, a, ev({ field: ZIP, kind: "denied", party: "customer", t: 3000 })], ZIP)).toMatchObject({ status: "VERIFIED" });
  });

  it("late / cut → PENDING (late_turn), flagged; v2 (no late/cut rule) verifies; tArmMs marks late turns", () => {
    const s = ev({ field: ZIP, kind: "stated", party: "customer", value: "44107", t: 1000 });
    const lateAck = ev({ field: ZIP, kind: "ack", party: "rep", t: 2000, ack: s.turnId, late: true });
    expect(field([s, lateAck], ZIP)).toMatchObject({ status: "PENDING", reason: "late_turn", flags: ["late_turn"] });
    const cutAck = ev({ field: ZIP, kind: "ack", party: "rep", t: 2000, ack: s.turnId, cut: true });
    expect(field([s, cutAck], ZIP)).toMatchObject({ status: "PENDING", reason: "late_turn", flags: ["cut_turn"] });
    expect(field([s, lateAck], ZIP, { rules: { lateCut: false } })).toMatchObject({ status: "VERIFIED", flags: ["late_turn"] });
    const plainAck = ev({ field: ZIP, kind: "ack", party: "rep", t: 2000, ack: s.turnId });
    expect(field([s, plainAck], ZIP, { tArmMs: 1500 })).toMatchObject({ status: "PENDING", reason: "late_turn" });
    expect(field([s, plainAck], ZIP, { tArmMs: 2000 })).toMatchObject({ status: "VERIFIED" });
  });

  it("the verifier downgrades but never upgrades; fills MISSING as PENDING (verifier_only)", () => {
    const s = ev({ field: ZIP, kind: "stated", party: "customer", value: "44107", t: 1000 });
    const a = ev({ field: ZIP, kind: "ack", party: "rep", t: 2000, ack: s.turnId });
    const disagree = ev({ field: ZIP, kind: "verifier", party: "verifier", value: "44108", t: 3000, turnId: null, evidence: null });
    expect(field([s, a, disagree], ZIP)).toMatchObject({ status: "PENDING", reason: "verifier_disagrees", flags: ["verifier_disagrees"], value: "44107" });
    expect(field([s, a, disagree], ZIP, { rules: { verifierOverlay: false } })).toMatchObject({ status: "VERIFIED" });
    const agree = ev({ field: ZIP, kind: "verifier", party: "verifier", value: "44107", t: 3000, turnId: null });
    expect(field([s, agree], ZIP)).toMatchObject({ status: "PENDING", reason: "stated_once" });
    const only = ev({ field: "license_state", kind: "verifier", party: "verifier", value: "WI", t: 3000, turnId: null, evidence: null, confidence: "medium" });
    expect(field([only], "license_state")).toMatchObject({ status: "PENDING", reason: "verifier_only", value: "WI", source: "verifier", display: "Wisconsin (WI)" });
    // An older run's disagreement is superseded by the latest run (events of one run share turnEndMs = uptoRecvMs).
    const newerRun = ev({ field: "license_state", kind: "verifier", party: "verifier", value: "WI", t: 9000, turnId: null });
    expect(field([s, a, disagree, newerRun], ZIP)).toMatchObject({ status: "VERIFIED" });
  });

  it("ctx.verifier (the latest VerifierResult) takes precedence over verifier events", () => {
    const s = ev({ field: ZIP, kind: "stated", party: "customer", value: "44107", t: 1000 });
    const a = ev({ field: ZIP, kind: "ack", party: "rep", t: 2000, ack: s.turnId });
    const oldDisagreement = ev({ field: ZIP, kind: "verifier", party: "verifier", value: "44108", t: 3000, turnId: null });
    const agrees: VerifierResult = { uptoRecvMs: 5000, fields: [{ field: ZIP, value: "44107", support: "stated_and_confirmed", turnIds: [], quote: "" }] };
    expect(field([s, a, oldDisagreement], ZIP, { verifier: agrees })).toMatchObject({ status: "VERIFIED" });
    const disagrees: VerifierResult = { uptoRecvMs: 5000, fields: [
      { field: ZIP, value: "four four one oh eight", support: "stated_once", turnIds: [], quote: "" },
      { field: "license_state", value: "Wisconsin", support: "stated_once", turnIds: [], quote: "" },
      { field: "driver_dob", value: null, support: "absent", turnIds: [], quote: "" },
    ] };
    const st = derive([s, a], { verifier: disagrees });
    expect(st.fields[ZIP]).toMatchObject({ status: "PENDING", reason: "verifier_disagrees" });
    expect(st.fields.license_state).toMatchObject({ status: "PENDING", reason: "verifier_only", value: "WI" });
    const view = verifierViewOf([], disagrees, { policy, callDate: policy.callDate });
    expect(view.has("driver_dob")).toBe(false);
    expect(verifierDisagrees(ZIP, "44107", view)).toBe(true);
    expect(verifierDisagrees("driver_dob", "2009-03-14", view)).toBe(false);
  });

  it("rep-only premium stated by the customer → PENDING (rep_only_violation); rep quote + customer ack → VERIFIED", () => {
    const P = "premium_new_monthly_usd" as const;
    const c = ev({ field: P, kind: "stated", party: "customer", value: "142.00", t: 1000 });
    expect(field([c, ev({ field: P, kind: "ack", party: "rep", t: 2000, ack: c.turnId })], P)).toMatchObject({ status: "PENDING", reason: "rep_only_violation" });
    const r = ev({ field: P, kind: "stated", party: "rep", value: "142.00", t: 1000 });
    expect(field([r, ev({ field: P, kind: "ack", party: "customer", t: 2000, ack: r.turnId })], P)).toMatchObject({ status: "VERIFIED", source: "rep", display: "$142 a month" });
  });

  it("tool_update → VERIFIED (ai_confirmed): overrides conflict, late and verifier; flags a corrected VERIFIED value", () => {
    const s = ev({ field: ZIP, kind: "stated", party: "customer", value: "44107", t: 1000 });
    const r = ev({ field: ZIP, kind: "stated", party: "rep", value: "44108", t: 2000, late: true });
    const tool = ev({ field: ZIP, kind: "tool_update", party: "ai", value: "44109", t: 90_000 });
    const st = derive([s, r, tool, ev({ field: ZIP, kind: "verifier", party: "verifier", value: "44100", t: 3000, turnId: null })]);
    expect(st.fields[ZIP]).toMatchObject({ status: "VERIFIED", reason: "ai_confirmed", value: "44109", source: "ai" });
    expect(st.conflicts).toEqual([]);
    const a = ev({ field: ZIP, kind: "ack", party: "rep", t: 1500, ack: s.turnId });
    const corrected = derive([s, a, tool]);
    expect(corrected.fields[ZIP]).toMatchObject({ status: "VERIFIED", reason: "ai_confirmed", flags: ["customer_corrected_verified"] });
    expect(corrected.conflicts[0]).toMatchObject({ field: ZIP, resolved: false, values: [{ value: "44107", party: "customer" }, { value: "44109", party: "ai" }] });
    // A later human statement does not silently replace an AI-confirmed value.
    const after = field([s, a, tool, ev({ field: ZIP, kind: "stated", party: "customer", value: "44100", t: 95_000 })], ZIP);
    expect([after.status, after.value]).toEqual(["VERIFIED", "44109"]);
  });

  it("policy events → VERIFIED (policy_record); question and unparseable events have no effect", () => {
    expect(field([ev({ field: "license_state", kind: "policy", party: "policy", value: "OH", t: 0, turnId: null })], "license_state"))
      .toMatchObject({ status: "VERIFIED", reason: "policy_record", source: "policy" });
    const q = field([
      ev({ field: ZIP, kind: "question", party: "rep", value: null, t: 500 }),
      ev({ field: ZIP, kind: "stated", party: "customer", value: null, t: 1000 }),
    ], ZIP);
    expect([q.status, q.reason, q.updatedAtMs]).toEqual(["MISSING", "absent", 1000]);
  });

  it("effective_date outside callDate..+60 → PENDING (out_of_range), flagged", () => {
    const E = "effective_date" as const;
    const s = ev({ field: E, kind: "stated", party: "customer", value: "2026-12-01", t: 1000 });
    const f = field([s, ev({ field: E, kind: "readback", party: "rep", value: "2026-12-01", t: 2000 })], E);
    expect(f).toMatchObject({ status: "PENDING", reason: "out_of_range", flags: ["out_of_range"] });
  });

  it("evidence: newest first, at most 3, deduplicated", () => {
    const evs = [1, 2, 3, 4].map((i) => ev({ field: ZIP, kind: i % 2 ? "stated" : "readback", party: i % 2 ? "customer" : "rep", value: "44107", t: i * 1000 }));
    const f = field(evs, ZIP);
    expect(f.evidence.map((e) => e.endMs)).toEqual([4000, 3000, 2000]);
    expect(f.updatedAtMs).toBe(4000);
  });
});

describe("deriveCaseState", () => {
  it("is exhaustive, schema-valid and deterministic (order by (turnEndMs, seq))", () => {
    const s = ev({ field: ZIP, kind: "stated", party: "customer", value: "44107", t: 1000, seq: 1 });
    const a = ev({ field: ZIP, kind: "ack", party: "rep", t: 2000, seq: 2, ack: s.turnId });
    const d = ev({ field: ZIP, kind: "denied", party: "rep", t: 2000, seq: 3 });
    const st = derive([d, a, s], { version: 7, stage: "confirm" });
    expect(CaseStateSchema.parse(st)).toEqual(st);
    expect(Object.keys(st.fields)).toHaveLength(21);
    expect(st.fields[ZIP]).toMatchObject({ status: "PENDING", reason: "denied" });
    expect(derive([s, d, a], { version: 7, stage: "confirm" })).toEqual(st);
    expect([st.version, st.stage, st.callClockMs]).toEqual([7, "confirm", 2000]);
    // equal turnEndMs: seq decides the order; a denial stays sticky either way
    const flipped = derive([s, { ...a, seq: 3 }, { ...d, seq: 2 }]);
    expect(flipped.fields[ZIP]).toMatchObject({ status: "PENDING", reason: "denied" });
    expect(sortEvents([{ ...s, seq: undefined }, { ...s, id: "x", turnEndMs: 0, seq: undefined }]).map((e) => e.id)).toEqual(["x", s.id]);
    expect(derive([]).callClockMs).toBe(0);
  });

  it("readiness: 10 required; the premium never blocks", () => {
    const req: [FieldId, string][] = [
      ["driver_full_name", "maya raman"], ["driver_dob", "2009-03-14"], ["driver_relation", "child"], ["license_state", "OH"],
      ["license_status", "provisional"], ["vehicle_assignment", "veh1"], ["operator_type", "primary"], ["garaging_zip", "44107"],
      ["effective_date", "2026-10-02"],
    ];
    let t = 0;
    const evs = req.flatMap(([f, v]) => {
      const s = ev({ field: f, kind: "stated", party: "customer", value: v, t: (t += 1000) });
      return [s, ev({ field: f, kind: "ack", party: "rep", t: (t += 1000), ack: s.turnId })];
    });
    const st = derive(evs);
    expect(st.readiness).toEqual({ verified: 9, pending: 0, missing: 1, requiredTotal: 10, ready: true });
    const withCustomerPremium = derive([...evs, ev({ field: "premium_new_monthly_usd", kind: "stated", party: "customer", value: "142.00", t: t + 1 })]);
    expect(withCustomerPremium.readiness).toMatchObject({ pending: 1, ready: true });
    const oneMissing = derive(evs.slice(2));
    expect(oneMissing.readiness).toMatchObject({ ready: false, missing: 2 });
  });

  it("age rule: a VERIFIED dob implies the age; inconsistent dob/age → both PENDING (conflict)", () => {
    const dob = ev({ field: "driver_dob", kind: "stated", party: "customer", value: "2009-03-14", t: 1000 });
    const rb = ev({ field: "driver_dob", kind: "readback", party: "rep", value: "2009-03-14", t: 2000 });
    const implied = derive([dob, rb]);
    expect(implied.fields.driver_age).toMatchObject({ status: "VERIFIED", value: "17", reason: "read_back" });
    const stated = derive([dob, rb, ev({ field: "driver_age", kind: "stated", party: "customer", value: "17", t: 1500 })]);
    expect(stated.fields.driver_age).toMatchObject({ status: "VERIFIED", value: "17", source: "customer" });
    const bad = derive([dob, rb, ev({ field: "driver_age", kind: "stated", party: "customer", value: "19", t: 1500 })]);
    expect(bad.fields.driver_age).toMatchObject({ status: "PENDING", reason: "conflict" });
    expect(bad.fields.driver_dob).toMatchObject({ status: "PENDING", reason: "conflict" });
    expect(bad.conflicts.some((c) => c.field === "driver_age")).toBe(true);
    const aiAge = derive([dob, rb, ev({ field: "driver_age", kind: "tool_update", party: "ai", value: "19", t: 1500 })]);
    expect(aiAge.fields.driver_dob.status).toBe("VERIFIED");
    const pendingDob = derive([dob]);
    expect(pendingDob.fields.driver_age.status).toBe("MISSING");
  });
});

describe("deriveV1 (naive)", () => {
  it("any stated value = VERIFIED; the latest value wins; no conflicts", () => {
    const st = deriveV1(policy, [
      ev({ field: ZIP, kind: "stated", party: "customer", value: "44107", t: 1000 }),
      ev({ field: ZIP, kind: "stated", party: "rep", value: "44108", t: 2000, late: true }),
      ev({ field: ZIP, kind: "question", party: "rep", value: null, t: 2500 }),
      ev({ field: "premium_new_monthly_usd", kind: "stated", party: "customer", value: "142.00", t: 3000 }),
    ], { caseId: "c1" });
    expect(st.fields[ZIP]).toMatchObject({ status: "VERIFIED", value: "44108", source: "rep" });
    expect(st.fields.premium_new_monthly_usd).toMatchObject({ status: "VERIFIED", display: "$142 a month" });
    expect(st.conflicts).toEqual([]);
    expect(st.callClockMs).toBe(3000);
    expect(deriveV1(policy, [], { caseId: "c1" }).readiness.verified).toBe(0);
    expect(CaseStateSchema.parse(st)).toEqual(st);
  });
});
