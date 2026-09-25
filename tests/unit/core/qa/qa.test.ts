import { describe, expect, it } from "vitest";
import { QaResultSchema } from "../../../../src/core/contracts";
import { disclosureText } from "../../../../src/core/compiler/disclosures";
import { compileGreeting } from "../../../../src/core/compiler/greeting";
import {
  classifySentence, computeQa, isRequest, norm, normTokens, sentencesOf, splitSentences, targetedFields, valueBearing,
  verbatimCheck, verbatimSimilarity, type QaInput,
} from "../../../../src/core/qa";
import { handoffStateOf, policyOf } from "../case/_fixtures";

const s01 = policyOf("s01");
const snap = handoffStateOf("s01");
const premium = disclosureText("premium_change", { snapshot: snap, policy: s01, monthlyUsd: "142.00", dueTodayUsd: "23.40" });
const esign = disclosureText("esign_consent", { snapshot: snap, policy: s01, monthlyUsd: "142.00", dueTodayUsd: "23.40" });

const base = (ch2: QaInput["ch2"], extra: Partial<QaInput> = {}): QaInput => ({
  provisional: false, snapshot: snap, policy: s01, ch2, toolCalls: [], disclosures: [], greeting: "", payment: "simulated",
  handedBack: false, aiSeconds: 90, ...extra,
});

describe("norm (§5.13 step 6.1)", () => {
  it("money, spelled numbers, ordinals, punctuation, fillers", () => {
    expect(norm("$142.00")).toBe("142 dollars");
    expect(norm("$142")).toBe("142 dollars");
    expect(norm("one hundred forty two dollars")).toBe("142 dollars");
    expect(norm("$34.10")).toBe("34 dollars 10 cents");
    expect(norm("thirty-four dollars and ten cents")).toBe("34 dollars 10 cents");
    expect(norm("$1,234.5")).toBe("1234 dollars 50 cents");
    expect(norm("Friday, October 2nd")).toBe("friday october 2");
    expect(norm("Friday, October second")).toBe("friday october 2");
    expect(norm("Uh, um, okay so the ZIP is four four one oh seven.")).toBe("the zip is 4 4 1 0 7");
    expect(norm("ending in 8 2 0 7")).toBe("ending in 8 2 0 7");
    expect(norm("It's -- e-sign")).toBe("it's e sign");
    expect(normTokens("")).toEqual([]);
  });

  it("sentences: split on [.?!] + space, tag questions merged", () => {
    expect(splitSentences("Just to confirm, the ZIP is 44107. Is that right? Great.").map((s) => s.sentence))
      .toEqual(["Just to confirm, the ZIP is 44107. Is that right?", "Great."]);
    expect(splitSentences("  Hello there.  How are you? ")).toEqual([{ sentence: "Hello there.", start: 2 }, { sentence: "How are you?", start: 16 }]);
    const words = "What's the ZIP? Thanks.".split(" ").map((w, i) => ({ text: w, startMs: 1000 + i * 300, endMs: 1200 + i * 300 }));
    expect(sentencesOf([{ text: "What's the ZIP? Thanks.", startMs: 1000, words }]).map((s) => s.atMs)).toEqual([1000, 1900]);
    expect(sentencesOf([{ text: "What's the ZIP? Thanks.", startMs: null }]).map((s) => s.atMs)).toEqual([0, 0]);
    const fewer = [{ text: "What's", startMs: 1000, endMs: 1100 }, { text: "ZIP?", startMs: 2000, endMs: 2100 }];
    expect(sentencesOf([{ text: "What's the ZIP? Thanks a lot.", startMs: 500, words: fewer }]).map((s) => s.atMs)).toEqual([1000, 2000]);
  });
});

describe("request detection and field targeting (§5.13 steps 3-5)", () => {
  it("isRequest", () => {
    expect(isRequest("What's the ZIP code?")).toBe(true);
    expect(isRequest("Could you tell me her date of birth")).toBe(true);
    expect(isRequest("To finish up, I just need the ZIP code.")).toBe(true);
    expect(isRequest("Please confirm the ZIP code.")).toBe(true);
    expect(isRequest("I have everything I need")).toBe(true);
    expect(isRequest("Thanks, that's all set.")).toBe(false);
  });
  it("valueBearing and classification by snapshot status", () => {
    expect(valueBearing("So the car is kept at 4 4 1 0 7, right?", "garaging_zip", "44107", s01)).toBe(true);
    expect(valueBearing("So the car is kept at four four one oh seven?", "garaging_zip", "44107", s01)).toBe(true);
    expect(valueBearing("What's the ZIP?", "garaging_zip", "44107", s01)).toBe(false);
    expect(classifySentence("What's the ZIP code where the car is kept?", snap, s01).fields).toEqual([{ field: "garaging_zip", classification: "reask" }]);
    expect(classifySentence("Is the car still kept at ZIP 44107?", snap, s01).fields).toEqual([{ field: "garaging_zip", classification: "verified_reconfirm" }]);
    const s02 = handoffStateOf("s02");
    expect(classifySentence("When would you like this to start?", s02, policyOf("s02")).fields).toEqual([{ field: "effective_date", classification: "pending_confirm" }]);
    const s05 = handoffStateOf("s05");
    expect(classifySentence("Which state issued Owen's license?", s05, policyOf("s05")).fields).toEqual([{ field: "license_state", classification: "new" }]);
    expect(classifySentence("You might want to raise your limits.", snap, s01)).toMatchObject({ isRequest: false, advice: true });
    expect(targetedFields("Can you spell that?")).toEqual(["driver_full_name"]);
  });
});

describe("computeQa: re-ask counter", () => {
  it("a re-ask of a VERIFIED ZIP → reAsked = 1 (distinct fields)", () => {
    const r = computeQa(base([
      { text: "What's the ZIP code where the car is kept overnight?", startMs: 1000 },
      { text: "Sorry, what was the ZIP again?", startMs: 5000 },
    ]));
    expect(r.reAsked).toBe(1);
    expect(r.details.filter((d) => d.classification === "reask")).toHaveLength(2);
    expect(QaResultSchema.parse(r)).toEqual(r);
  });

  it("a confirmation including the value → verified_reconfirm, not a re-ask", () => {
    const r = computeQa(base([{ text: "Just to double check, the car is kept at ZIP code 4 4 1 0 7, is that right?", startMs: 1000 }]));
    expect([r.reAsked, r.verifiedReconfirmed]).toEqual([0, 1]);
  });

  it("the greeting's own confirm counts as pendingConfirmed; a MISSING ask as newlyAsked", () => {
    const s02 = handoffStateOf("s02");
    const g = compileGreeting(s02, policyOf("s02")).text;
    const r = computeQa({ ...base([{ text: g, startMs: 0 }]), snapshot: s02, policy: policyOf("s02") });
    expect([r.pendingConfirmed, r.reAsked, r.newlyAsked]).toEqual([1, 0, 0]);
    const s05 = handoffStateOf("s05");
    const g5 = compileGreeting(s05, policyOf("s05")).text;
    const r5 = computeQa({ ...base([]), greeting: g5, prependGreeting: true, snapshot: s05, policy: policyOf("s05") });
    expect([r5.newlyAsked, r5.reAsked]).toEqual([1, 0]);
    const g1 = compileGreeting(snap, s01).text;
    const r1 = computeQa(base([{ text: g1, startMs: 0 }]));
    expect([r1.reAsked, r1.newlyAsked, r1.pendingConfirmed]).toEqual([0, 0, 0]);
  });

  it("disclosure spans are excluded; advice outside them is flagged; unclassified requests are 'other'", () => {
    const r = computeQa(base([
      { text: premium.text, startMs: 10_000 },
      { text: "Great. Would you like to raise your liability limits?", startMs: 40_000 },
      { text: "Anything else I can help with?", startMs: 50_000 },
    ], { disclosures: [{ kind: "premium_change", text: premium.text, criticalTokens: premium.criticalTokens, atMs: 9_500 }] }));
    expect(r.disclosures).toEqual([{ kind: "premium_change", similarity: 1, ok: true, missingCritical: [] }]);
    expect(r.reAsked).toBe(0);
    expect(r.adviceFlags).toBe(1);
    expect(r.details.map((d) => d.classification)).toEqual(["advice", "other"]);
    expect(r.details.some((d) => d.sentence.includes("starting Friday"))).toBe(false);
  });

  it("passes through payment, hand-back, seconds, latency and the provisional flag", () => {
    const r = computeQa(base([], { provisional: true, handedBack: true, payment: "unpaid", aiSeconds: 12.5, latency: { clickToFirstAudibleMs: 1200, turnLatencyP50Ms: 2400 } }));
    expect(r).toMatchObject({ provisional: true, handedBack: true, payment: "unpaid", aiSeconds: 12.5, clickToFirstAudibleMs: 1200, deadAirAfterRepMs: null, turnLatencyP50Ms: 2400 });
  });
});

describe("verbatim check (§5.13 step 6)", () => {
  it("exact → 1.0 and ok", () => {
    const r = verbatimCheck(premium.text, normTokens(`Okay. ${premium.text} Take your time.`), premium.criticalTokens);
    expect([r.similarity, r.ok, r.missingCritical]).toEqual([1, true, []]);
  });
  it("number words ≡ digits", () => {
    const spoken = premium.text.replace("$142", "one hundred forty-two dollars").replace("$23.40", "twenty-three dollars and forty cents").replace("2nd", "second");
    expect(verbatimSimilarity(premium.text, spoken)).toBe(1);
    const e = esign.text.replace("8 2 0 7", "eight two oh seven");
    expect(verbatimCheck(esign.text, normTokens(e), esign.criticalTokens)).toMatchObject({ similarity: 1, ok: true });
  });
  it("a paraphrase → < 0.9 and ok = false", () => {
    const para = "So we're putting Maya on your Civic from October 2nd. It'll be $142 a month and $23.40 today. Sound good?";
    const r = verbatimCheck(premium.text, normTokens(para), premium.criticalTokens);
    expect(r.similarity).toBeLessThan(0.9);
    expect(r.ok).toBe(false);
  });
  it("a missing critical token → ok = false even when similar", () => {
    const spoken = premium.text.replace("$23.40", "$24.40");
    const r = verbatimCheck(premium.text, normTokens(spoken), premium.criticalTokens);
    expect(r.similarity).toBeGreaterThan(0.9);
    expect(r.missingCritical).toEqual(["$23.40"]);
    expect(r.ok).toBe(false);
  });
  it("nothing spoken → 0; empty disclosure → 1", () => {
    expect(verbatimCheck(premium.text, [], premium.criticalTokens)).toMatchObject({ similarity: 0, ok: false });
    expect(verbatimCheck("", ["a"], [])).toMatchObject({ similarity: 1, ok: true });
    const r = computeQa(base([{ text: "Let me check.", startMs: 200_000 }], {
      disclosures: [{ kind: "esign_consent", text: esign.text, criticalTokens: esign.criticalTokens, atMs: 1_000 }],
    }));
    expect(r.disclosures[0]).toMatchObject({ kind: "esign_consent", similarity: 0, ok: false });
  });
});
