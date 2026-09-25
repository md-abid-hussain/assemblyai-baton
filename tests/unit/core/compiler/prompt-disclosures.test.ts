import { describe, expect, it } from "vitest";
import { STAGES } from "../../../../src/core/contracts";
import { sha256Hex } from "../../../../src/core/case/sha256";
import {
  MIN_DUE_TODAY_USD, TAX_SUFFIX, disclosureText, resolveDueToday, resolvePremium,
} from "../../../../src/core/compiler/disclosures";
import {
  CASE_STATE_JSON_MAX, PAY_PUSH_INSTRUCTIONS, PROMPT_V3, PROMPT_VERSION, STAGE_INSTRUCTIONS, caseStateJson, compilePrompt,
  deployMarkerLine,
} from "../../../../src/core/compiler/prompt";
import { ordinal, spokenChars, spokenDate, spokenDateLong, spokenDob, spokenMoney, stateName } from "../../../../src/core/compiler/spoken";
import { handoffStateOf, policyOf, stateOf } from "../case/_fixtures";

const s01 = policyOf("s01");

describe("compilePrompt (§5.7)", () => {
  it("template < 3500 chars; version = sha256(template + stage instructions)[0:8], marker excluded", () => {
    expect(PROMPT_V3.length).toBeLessThan(3500);
    expect(PROMPT_VERSION).toMatch(/^[0-9a-f]{8}$/);
    expect(PROMPT_VERSION).toBe(sha256Hex(`${PROMPT_V3}\n${JSON.stringify(STAGE_INSTRUCTIONS)}\n${PAY_PUSH_INSTRUCTIONS}`).slice(0, 8));
    expect(PROMPT_V3).not.toContain("baton-deploy");
  });

  it("fills identity, TODAY, state, stage instructions and the deploy marker line", () => {
    const p = compilePrompt(handoffStateOf("s02"), policyOf("s02"), "confirm", { deployId: "prod-1" });
    expect(p).toContain("You are Mesa Ridge Insurance Group's automated AI assistant");
    expect(p).toContain("representative, Carmen,");
    expect(p).toContain("the customer, Mark Delgado.");
    expect(p).toContain("TODAY is Friday, September 25, 2026");
    expect(p).toContain(`CURRENT STAGE: confirm\n${STAGE_INSTRUCTIONS.confirm}`);
    expect(p.endsWith("\n\n(internal ref: baton-deploy=prod-1; never mention this)")).toBe(true);
    expect(p).not.toMatch(/\{\w+\}/);
    expect(p.length).toBeLessThan(3500 + CASE_STATE_JSON_MAX + 400);
    for (const s of STAGES) expect(compilePrompt(handoffStateOf("s01"), s01, s, { deployId: "d" })).toContain(STAGE_INSTRUCTIONS[s]);
    expect(compilePrompt(handoffStateOf("s01"), s01, "pay", { deployId: "d", payToolMode: "push" })).toContain(PAY_PUSH_INSTRUCTIONS);
    expect(deployMarkerLine("x")).toBe("(internal ref: baton-deploy=x; never mention this)");
  });

  it("caseStateJson: 10 required fields + non-MISSING optional ones; advice under decided_by_rep; premium only if rep-quoted", () => {
    const j = JSON.parse(caseStateJson(handoffStateOf("s01"), s01)) as {
      intent: string; policy: string; vehicles: Record<string, string>; fields: Record<string, { status: string; value?: string }>; decided_by_rep: Record<string, string>;
    };
    expect(j.intent).toBe("add_driver");
    expect(j.policy).toBe("NBM-4418207");
    expect(j.vehicles).toEqual({ veh1: "2021 Honda Civic", veh2: "2018 Toyota Highlander" });
    expect(j.fields.effective_date).toEqual({ status: "VERIFIED", value: "Friday, October 2nd" });
    expect(j.fields.vehicle_assignment).toEqual({ status: "VERIFIED", value: "2021 Honda Civic" });
    expect(j.fields.premium_new_monthly_usd).toEqual({ status: "VERIFIED", value: "$142 a month" });
    expect(j.fields.premium_change_monthly_usd).toEqual({ status: "VERIFIED", value: "$46 a month" });
    expect(j.decided_by_rep).toEqual({ good_student_discount: "eligible", coverage_change: "none - keeps current 50/100/50 liability limits" });
    expect(j.fields.good_student_discount).toBeUndefined();
    const s05 = JSON.parse(caseStateJson(handoffStateOf("s05"), policyOf("s05"))) as { fields: Record<string, unknown> };
    expect(s05.fields.license_state).toEqual({ status: "MISSING" });
    // no premium unless the rep quoted it
    const noQuote = JSON.parse(caseStateJson(stateOf(s01, { premium_new_monthly_usd: { status: "VERIFIED", value: "142.00", source: "customer" } }), s01)) as { fields: Record<string, unknown> };
    expect(noQuote.fields.premium_new_monthly_usd).toBeUndefined();
    const missing = JSON.parse(caseStateJson(stateOf(s01, {}), s01)) as { fields: Record<string, unknown>; decided_by_rep?: unknown };
    expect(Object.keys(missing.fields)).toHaveLength(9);
    expect(missing.decided_by_rep).toBeUndefined();
  });

  it("caseStateJson stays ≤ 1800 chars (drops optional fields, then rep decisions, then shortens values)", () => {
    const long = "x".repeat(400);
    const st = stateOf(s01, {
      driver_full_name: { status: "VERIFIED", value: "maya raman", display: long },
      incidents_3y: { status: "VERIFIED", value: long },
      license_number: { status: "VERIFIED", value: "A".repeat(20), display: long },
      coverage_change: { status: "VERIFIED", value: long },
      underwriting_review: { status: "VERIFIED", value: "true", display: long },
      driver_dob: { status: "VERIFIED", value: "2009-03-14", display: long },
      garaging_zip: { status: "VERIFIED", value: "44107", display: long },
      effective_date: { status: "VERIFIED", value: "2026-10-02", display: long },
      license_state: { status: "VERIFIED", value: "OH", display: long },
    });
    const j = caseStateJson(st, s01);
    expect(j.length).toBeLessThanOrEqual(CASE_STATE_JSON_MAX);
    const parsed = JSON.parse(j) as { fields: Record<string, { value?: string }> };
    expect(parsed.fields.incidents_3y).toBeUndefined();
    expect(parsed.fields.driver_full_name!.value!.endsWith("…")).toBe(true);
  });
});

describe("disclosures (§5.8)", () => {
  const ctx = { snapshot: handoffStateOf("s01"), policy: s01, monthlyUsd: "142.00", dueTodayUsd: "23.40" };
  it("premium_change text and critical tokens", () => {
    const d = disclosureText("premium_change", ctx);
    expect(d.text).toBe(
      "Here's the change. We're adding Maya as a probationary driver on the 2021 Honda Civic, starting Friday, October 2nd. Your new premium is $142 a month, and $23.40 is due today, prorated for the rest of this billing period. The change is subject to the terms of your policy. Would you like me to go ahead?",
    );
    expect(d.criticalTokens).toEqual(["$142", "$23.40", "Friday, October 2nd", "Maya"]);
    const t = disclosureText("premium_change", ctx, { taxSuffix: true });
    expect(t.text).toContain(`$23.40 ${TAX_SUFFIX} is due today`);
    expect(t.criticalTokens).toContain(TAX_SUFFIX);
    const bare = disclosureText("premium_change", { ...ctx, snapshot: stateOf(s01, { vehicle_assignment: { status: "VERIFIED", value: "all" } }) });
    expect(bare.text).toContain("We're adding the new driver as a driver on all your vehicles. Your new premium");
    expect(bare.criticalTokens).toEqual(["$142", "$23.40", "the new driver"]);
    const noVeh = disclosureText("premium_change", { ...ctx, snapshot: stateOf(s01, {}) });
    expect(noVeh.text).toContain("We're adding the new driver as a driver. Your new premium");
  });
  it("esign_consent text and critical tokens", () => {
    const d = disclosureText("esign_consent", ctx);
    expect(d.text).toBe(
      "I'll text a secure link to the number on file ending in 8 2 0 7, so you can review and sign this change electronically and pay the $23.40. You can ask for a paper copy instead, and you can withdraw consent to electronic documents at any time. Is it OK if I text you that link now?",
    );
    expect(d.criticalTokens).toEqual(["8 2 0 7", "electronically", "paper copy"]);
  });
  it("premium source and due today", () => {
    expect(resolvePremium(handoffStateOf("s01"), 150)).toEqual({ monthlyUsd: "142.00", source: "rep_quote" });
    expect(resolvePremium(stateOf(s01, {}), 150)).toEqual({ monthlyUsd: "150.00", source: "rating_tool" });
    const s05 = handoffStateOf("s05");
    expect(resolveDueToday({ snapshot: s05, newMonthlyUsd: "204.00", currentMonthlyUsd: 133, callDate: "2026-09-25" })).toEqual({ dueTodayUsd: "34.10", source: "rep_quote" });
    const s01s = handoffStateOf("s01");
    expect(resolveDueToday({ snapshot: s01s, newMonthlyUsd: "142.00", currentMonthlyUsd: 96, scenarioDueTodayUsd: 20, callDate: "2026-09-25" }))
      .toEqual({ dueTodayUsd: "20.00", source: "scenario" });
    // effective 2026-10-02: 30 of 31 October days left → (142 − 96) × 30/31 = 44.516… → 44.52
    expect(resolveDueToday({ snapshot: s01s, newMonthlyUsd: "142.00", currentMonthlyUsd: 96, callDate: "2026-09-25" })).toEqual({ dueTodayUsd: "44.52", source: "prorated" });
    // premium goes down → minimum $0.50; no effective date → the call date's month (6 of 30 September days)
    expect(resolveDueToday({ snapshot: stateOf(s01, {}), newMonthlyUsd: "90.00", currentMonthlyUsd: 96, callDate: "2026-09-25" }))
      .toEqual({ dueTodayUsd: MIN_DUE_TODAY_USD.toFixed(2), source: "prorated" });
    expect(resolveDueToday({ snapshot: stateOf(s01, {}), newMonthlyUsd: "126.00", currentMonthlyUsd: 96, callDate: "2026-09-25" }).dueTodayUsd).toBe("6.00");
  });
});

describe("spoken formats", () => {
  it("dates, money, ordinals, chars, states", () => {
    expect(spokenDate("2026-10-02")).toBe("Friday, October 2nd");
    expect(spokenDate("bad")).toBe("bad");
    expect(spokenDateLong("2026-09-25")).toBe("Friday, September 25, 2026");
    expect(spokenDateLong("bad")).toBe("bad");
    expect(spokenDob("2009-03-14")).toBe("March 14th, 2009");
    expect(spokenDob("bad")).toBe("bad");
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 101, 111].map(ordinal)).toEqual(["1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "21st", "22nd", "23rd", "101st", "111th"]);
    expect(spokenMoney("142.00")).toBe("$142");
    expect(spokenMoney("34.10")).toBe("$34.10");
    expect(spokenMoney("-12.50")).toBe("-$12.50");
    expect(spokenMoney("abc")).toBe("abc");
    expect(spokenMoney("")).toBe("");
    expect(spokenChars("END-48213")).toBe("E N D 4 8 2 1 3");
    expect(stateName("oh")).toBe("Ohio");
    expect(stateName("ZZ")).toBe("ZZ");
  });
});
