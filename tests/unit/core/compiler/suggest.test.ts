import { describe, expect, it } from "vitest";
import { compileGreeting } from "../../../../src/core/compiler/greeting";
import { disclosureText } from "../../../../src/core/compiler/disclosures";
import { answerFor, askCount, classifyAgentText, suggestReplies, truthSpoken, type SuggestCtx } from "../../../../src/core/compiler/suggest";
import { handoffStateOf, policyOf, stateOf, truthOf } from "../case/_fixtures";

const ctxOf = (id: string, lastAgentText: string, extra: Partial<SuggestCtx> = {}): SuggestCtx => ({
  lastAgentText, snapshot: handoffStateOf(id), truth: truthOf(id), stage: "confirm", paymentStatus: null, policy: policyOf(id), ...extra,
});
const texts = (c: SuggestCtx) => suggestReplies(c).map((s) => s.text);

describe("suggestReplies (DESIGN §5.15)", () => {
  it("the s02 greeting's confirm (value matches truth) → 'Yes, that's right.' + always-appended chips", () => {
    const g = compileGreeting(handoffStateOf("s02"), policyOf("s02")).text;
    const s = suggestReplies(ctxOf("s02", g));
    expect(s.map((x) => x.text)).toEqual(["Yes, that's right.", "Can I talk to Carmen?", "Sorry, could you repeat that?"]);
    expect(s.map((x) => x.kind)).toEqual(["confirm", "handback", "repeat"]);
    expect(s[0]).toMatchObject({ id: "confirm:yes-that-s-right", audioUrl: null, voice: "synthetic" });
  });

  it("a confirm with a wrong value → 'No, it's {truth}.'", () => {
    expect(texts(ctxOf("s01", "Just to confirm, the car is kept at ZIP code 4 4 1 0 8. Is that right?"))[0]).toBe("No, it's 4 4 1 0 7.");
    expect(texts(ctxOf("s01", "So Maya will mainly drive the Highlander, correct?"))[0]).toBe("No, it's the 2021 Honda Civic.");
  });

  it("an open question → the truthful answer (s05 license state = Wisconsin)", () => {
    const g = compileGreeting(handoffStateOf("s05"), policyOf("s05")).text;
    expect(texts(ctxOf("s05", g))[0]).toBe("Wisconsin.");
    expect(texts(ctxOf("s01", "What's the ZIP code where the car is kept overnight?"))[0]).toBe("It's 4 4 1 0 7.");
    expect(texts(ctxOf("s01", "When would you like the change to start?"))[0]).toBe("Friday, October 2nd, please.");
  });

  it("the loop breaker: a field asked twice → explicit field-plus-value sentence", () => {
    const c = ctxOf("s01", "Sorry, what's Maya's date of birth?", { history: ["What's her date of birth?"] });
    expect(texts(c)[0]).toBe("Maya's date of birth is March 14th, 2009.");
    const op = ctxOf("s01", "Will she drive it every day?", { history: ["How often will she drive it, every day?"] });
    expect(texts(op)[0]).toBe("Maya will be the primary driver of the 2021 Honda Civic.");
    expect(askCount(["What's her date of birth? And the ZIP?"], "driver_dob")).toBe(1);
  });

  it("disclosure premium, e-sign consent, paying, closing, unclassified", () => {
    const snap = handoffStateOf("s01");
    const p = disclosureText("premium_change", { snapshot: snap, policy: policyOf("s01"), monthlyUsd: "142.00", dueTodayUsd: "23.40" });
    const e = disclosureText("esign_consent", { snapshot: snap, policy: policyOf("s01"), monthlyUsd: "142.00", dueTodayUsd: "23.40" });
    expect(texts(ctxOf("s01", p.text, { stage: "disclose" }))[0]).toBe("Yes, go ahead.");
    expect(texts(ctxOf("s01", e.text, { stage: "disclose" }))[0]).toBe("Yes, text me the link. No paper copy, thanks.");
    expect(texts(ctxOf("s01", "I've texted the link.", { stage: "pay", paymentStatus: "open" }))[0]).toBe("Okay, I'm paying now.");
    expect(texts(ctxOf("s01", "Your confirmation number is E N D 4 8 2 1 3. Is there anything else about this change?", { stage: "close", paymentStatus: "succeeded" }))[0])
      .toBe("No, that's everything. Thanks, bye!");
    expect(texts(ctxOf("s01", "Thanks for your patience, goodbye.", { stage: "close", paymentStatus: "succeeded" }))[0]).toBe("No, that's everything. Thanks, bye!");
    expect(texts(ctxOf("s01", "Great, thanks."))).toEqual(["Okay.", "Sure.", "Can I talk to Daniel?", "Sorry, could you repeat that?"]);
    expect(texts(ctxOf("s01", "What's the license number?", { truth: {} }))[0]).toBe("I'm not sure, sorry.");
  });

  it("the 'Try this' chip proposes the other policy vehicle (a live conflict)", () => {
    const s = suggestReplies(ctxOf("s01", "Great, thanks.", { offerTry: true }));
    expect(s.find((x) => x.kind === "try")?.text).toBe("Actually, Maya will mainly drive the Highlander.");
    expect(suggestReplies(ctxOf("s01", "Great.", { offerTry: true, stage: "pay" })).some((x) => x.kind === "try")).toBe(false);
    const noVeh = suggestReplies({ ...ctxOf("s01", "Great.", { offerTry: true }), snapshot: stateOf(policyOf("s01"), {}) });
    expect(noVeh.some((x) => x.kind === "try")).toBe(false);
  });

  it("classifyAgentText and answer helpers", () => {
    const c = { snapshot: handoffStateOf("s01"), truth: truthOf("s01"), policy: policyOf("s01") };
    expect(classifyAgentText("Can you hold on a second? Thanks.", c)).toMatchObject({ kind: "request", field: null });
    expect(classifyAgentText("I've updated that.", c)).toMatchObject({ kind: "statement" });
    const p = policyOf("s01");
    expect(answerFor("driver_full_name", "maya raman", p, "Maya")).toBe("It's Maya Raman.");
    expect(answerFor("driver_relation", "child", p, "Maya")).toBe("Maya is my child.");
    expect(answerFor("incidents_3y", "none", p, "Maya")).toBe("No tickets or accidents.");
    expect(answerFor("incidents_3y", "one ticket", p, "Maya")).toBe("Yes: one ticket.");
    expect(answerFor("license_status", "provisional", p, "Maya")).toBe("A probationary license.");
    expect(answerFor("vehicle_assignment", "all", p, "Maya")).toBe("All of them.");
    expect(answerFor("operator_type", "occasional", p, "Maya")).toBe("Just occasionally.");
    expect(answerFor("license_number", "A12", p, "Maya")).toBe("It's A 1 2.");
    expect(answerFor("driver_dob", "2009-03-14", p, "Maya")).toBe("March 14th, 2009.");
    expect(truthSpoken("operator_type", "primary", p)).toBe("every day");
    expect(truthSpoken("driver_relation", "child", p)).toBe("my child");
    expect(truthSpoken("good_student_discount", "pending_proof", p)).toBe("pending proof");
    expect(truthSpoken("incidents_3y", "none", p)).toBe("no tickets or accidents");
    expect(truthSpoken("driver_full_name", "maya raman", p)).toBe("Maya Raman");
  });
});
