import { describe, expect, it } from "vitest";
import type { RawPatchEvent, TurnInput, VerifierResult } from "../../../../src/core/contracts";
import { NewFactEventSchema } from "../../../../src/core/contracts";
import {
  alignEvidence, applyExtraction, locateQuote, toolUpdateEvent, verifierDisagreementEvents,
} from "../../../../src/core/case/apply";
import { deriveCaseState } from "../../../../src/core/case/derive";
import { handoffStateOf, policyOf } from "./_fixtures";

const policy = policyOf("s01");

function turn(turnId: string, channel: "rep" | "customer", text: string, t0: number, opts: Partial<TurnInput> = {}): TurnInput {
  const words = text.split(/\s+/).map((w, i) => ({ text: w, startMs: t0 + i * 300, endMs: t0 + i * 300 + 250, confidence: 0.9 }));
  return {
    caseId: "c1", turnId, channel, text, startMs: t0, endMs: words.at(-1)!.endMs, words, source: "stt_live", recvMs: t0 + 5000,
    cut: false, late: false, ...opts,
  };
}
const raw = (e: Partial<RawPatchEvent> & Pick<RawPatchEvent, "turn_id" | "field" | "kind">): RawPatchEvent => ({
  value: null, quote: "", acknowledges_turn_id: null, confidence: "high", ...e,
});

describe("locateQuote / alignEvidence (§5.3 step 5)", () => {
  const t = turn("customer-3", "customer", "March 14th, 2009.  She's   seventeen.", 10_000);
  it("exact, case- and whitespace-insensitive", () => {
    expect(locateQuote("she's seventeen", t.text)).toMatchObject({ how: "exact" });
    const e = alignEvidence("she's seventeen", t);
    expect(e).toEqual({ channel: "customer", turnId: "customer-3", source: "stt_live", startMs: 10_900, endMs: 11_450, quote: "She's   seventeen" });
    expect(alignEvidence("March 14th, 2009", t)).toMatchObject({ startMs: 10_000, endMs: 10_850, quote: "March 14th, 2009" });
  });
  it("token-LCS window ≥ 0.8 when the quote is not verbatim", () => {
    const u = turn("rep-4", "rep", "Okay so will she mainly be driving the Civic then?", 0);
    expect(locateQuote("will she mainly drive the Civic", u.text)).toMatchObject({ how: "lcs" });
    const e = alignEvidence("will she mainly drive the Civic", u);
    expect(e.quote).toBe("will she mainly be driving the Civic");
    expect([e.startMs, e.endMs]).toEqual([600, 2650]);
  });
  it("whole turn fallback, quote truncated to 200 chars; cached source; proportional word mapping", () => {
    const u = turn("rep-c5", "rep", "Something else entirely.", 0, { source: "stt_cache" });
    expect(alignEvidence("x".repeat(300), u)).toMatchObject({ startMs: 0, endMs: u.endMs, source: "stt_cache", quote: "x".repeat(200) });
    expect(alignEvidence("   ", u).quote).toBe("Something else entirely.");
    const noWords = { ...u, words: [] };
    expect(alignEvidence("else", noWords)).toMatchObject({ startMs: 0, endMs: u.endMs, quote: "else" });
    const fewer = { ...turn("rep-6", "rep", "a b c d e f g h", 0), words: [0, 1, 2, 3].map((i) => ({ text: "w", startMs: i * 1000, endMs: i * 1000 + 900, confidence: 1 })) };
    expect(alignEvidence("g h", fewer)).toMatchObject({ startMs: 3000, endMs: 3900 });
    expect(alignEvidence("c d", fewer)).toMatchObject({ startMs: 1000, endMs: 1900 });
    expect(locateQuote("zzz", "")).toBeNull();
  });
});

describe("applyExtraction (§5.3 post-processing)", () => {
  const rep = turn("rep-11", "rep", "March 14th, 2009, got it. Will she mainly drive the Civic?", 20_000, { late: true });
  const cust = turn("customer-12", "customer", "Yes. Her ZIP is four four one oh seven.", 25_000, { cut: true });
  const patch = {
    no_facts: false,
    events: [
      raw({ turn_id: "rep-11", field: "driver_dob", kind: "readback", value: "2009-03-14", quote: "March 14th, 2009, got it" }),
      raw({ turn_id: "rep-11", field: "vehicle_assignment", kind: "stated", value: "veh1", quote: "Will she mainly drive the Civic?" }),
      raw({ turn_id: "rep-10", field: "driver_full_name", kind: "stated", value: "Maya", quote: "Maya" }), // not a new turn → dropped
      raw({ turn_id: "rep-11", field: "operator_type", kind: "stated", value: null, quote: "mainly" }), // value-less stated → dropped
      raw({ turn_id: "customer-12", field: "vehicle_assignment", kind: "ack", value: null, quote: "Yes", acknowledges_turn_id: "rep-11" }),
      raw({ turn_id: "customer-12", field: "garaging_zip", kind: "stated", value: "four four one oh seven", quote: "four four one oh seven", confidence: "medium" }),
      raw({ turn_id: "customer-12", field: "license_state", kind: "question", value: "OH", quote: "Her" }),
      raw({ turn_id: "customer-12", field: "driver_dob", kind: "stated", value: "last spring", quote: "Yes" }), // unparseable → kept, valueNorm null
    ],
  };
  const out = applyExtraction(patch, [rep, cust], { caseId: "c1", policy });

  it("drops foreign turns and value-less statements; party from the channel; normalizes; copies late/cut", () => {
    expect(out.map((e) => `${e.turnId}/${e.field}/${e.kind}`)).toEqual([
      "rep-11/driver_dob/readback", "rep-11/vehicle_assignment/stated", "customer-12/vehicle_assignment/ack",
      "customer-12/garaging_zip/stated", "customer-12/license_state/question", "customer-12/driver_dob/stated",
    ]);
    for (const e of out) expect(NewFactEventSchema.parse(e)).toEqual(e);
    expect(out[0]).toMatchObject({ party: "rep", valueNorm: "2009-03-14", late: true, cut: false, turnEndMs: rep.endMs, extractor: "luna", id: "c1:rep-11:0" });
    expect(out[2]).toMatchObject({ party: "customer", acknowledgesTurnId: "rep-11", valueNorm: null, cut: true });
    expect(out[3]).toMatchObject({ valueRaw: "four four one oh seven", valueNorm: "44107", confidence: "medium" });
    expect(out[4]).toMatchObject({ kind: "question", valueRaw: null, valueNorm: null });
    expect(out[5]).toMatchObject({ valueRaw: "last spring", valueNorm: null });
    expect(out[1]!.evidence).toMatchObject({ channel: "rep", quote: "Will she mainly drive the Civic?" });
  });

  it("custom ids and callDate; the derived state treats the rep's proposal + customer ack as VERIFIED (late → PENDING)", () => {
    const ids = applyExtraction(patch, [rep, cust], { caseId: "c1", policy, callDate: "2026-09-25", newId: (t, i) => `x-${t}-${i}` });
    expect(ids[0]!.id).toBe("x-rep-11-0");
    const st = deriveCaseState(policy, out, { caseId: "c1" });
    expect(st.fields.vehicle_assignment).toMatchObject({ status: "PENDING", reason: "late_turn", value: "veh1" });
    const fresh = applyExtraction(patch, [{ ...rep, late: false }, { ...cust, cut: false }], { caseId: "c1", policy });
    expect(deriveCaseState(policy, fresh, { caseId: "c1" }).fields.vehicle_assignment).toMatchObject({ status: "VERIFIED", reason: "acknowledged" });
  });
});

describe("verifier and tool events (G0 encodings)", () => {
  it("verifierDisagreementEvents: only fields MISSING or incompatible in the state", () => {
    const state = handoffStateOf("s05");
    const cited = turn("customer-7", "customer", "He got his license in Wisconsin.", 30_000);
    const result: VerifierResult = { uptoRecvMs: 42_000, fields: [
      { field: "license_state", value: "Wisconsin", support: "stated_once", turnIds: ["customer-7"], quote: "in Wisconsin" },
      { field: "garaging_zip", value: "60540", support: "stated_and_confirmed", turnIds: [], quote: "" }, // agrees → nothing
      { field: "effective_date", value: "2026-10-02", support: "conflicting", turnIds: ["rep-99"], quote: "" }, // disagrees
      { field: "driver_dob", value: null, support: "absent", turnIds: [], quote: "" },
      { field: "incidents_3y", value: "   ", support: "stated_once", turnIds: [], quote: "" }, // unparseable
    ] };
    const evs = verifierDisagreementEvents(result, state, [cited], { caseId: "c5", policy: policyOf("s05") });
    expect(evs.map((e) => [e.field, e.valueNorm, e.confidence])).toEqual([["license_state", "WI", "medium"], ["effective_date", "2026-10-02", "low"]]);
    expect(evs[0]).toMatchObject({ kind: "verifier", party: "verifier", extractor: "sol", turnId: null, turnEndMs: 42_000, late: false, id: "c5:verifier@42000:license_state" });
    expect(evs[0]!.evidence).toMatchObject({ turnId: "customer-7", quote: "in Wisconsin" });
    expect(evs[1]!.evidence).toBeNull();
    const withIds = verifierDisagreementEvents(result, state, [], { caseId: "c5", policy: policyOf("s05"), newId: (t, i) => `${t}#${i}` });
    expect(withIds[0]!.id).toBe("verifier@42000#0");
    for (const e of evs) expect(NewFactEventSchema.parse(e)).toEqual(e);
  });

  it("toolUpdateEvent", () => {
    const e = toolUpdateEvent({ id: "t1", caseId: "c1", field: "license_state", valueRaw: "Wisconsin", valueNorm: "WI", turnEndMs: 95_000.5 });
    expect(e).toMatchObject({ kind: "tool_update", party: "ai", extractor: "tool", confidence: "high", turnId: null, evidence: null });
    expect(NewFactEventSchema.parse(e)).toEqual(e);
  });
});
