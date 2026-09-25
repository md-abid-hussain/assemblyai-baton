import { describe, expect, it } from "vitest";
import type { CaseState, FieldId, FieldStatus, Party, PolicyRecord } from "../../../../src/core/contracts";
import { addDays } from "../../../../src/core/case/dates";
import {
  GREETING_DISCLOSURE_RES, GREETING_MAX_WORDS, GREETING_OPENING_MAX_WORDS, assertGreetingInvariant, compileGreeting,
  compileGreetingV1, greetingOpening, wordsIn,
} from "../../../../src/core/compiler/greeting";
import { spokenDate, spokenDob, spokenMoney, spokenZip, stateName } from "../../../../src/core/compiler/spoken";
import { GREETING_PRIORITY, firstNameOf, licenseWords, vehicleLabelOf } from "../../../../src/core/intents/add-driver";
import { LICENSE_STATUSES, OPERATOR_TYPES, RELATIONS, US_STATES } from "../../../../src/core/intents/add-driver.fields";
import { handoffStateOf, policyOf, stateOf, type FieldSpec } from "../case/_fixtures";

const s01 = policyOf("s01");

describe("compileGreeting: scenario examples (DESIGN §5.6, v2.1 ≤ 40 words)", () => {
  it("s01 at the planned hand-off: every clause, premium quoted by the rep, 'ready?' close, ≤ 40 words", () => {
    const g = compileGreeting(handoffStateOf("s01"), s01);
    expect(g.text).toBe(
      "Hi Priya, I'm Daniel's AI assistant, not a person. This call is recorded. " +
        "I'll finish adding Maya to the 2021 Honda Civic, starting Friday, October 2nd, at $142 a month. " +
        "Ask for Daniel anytime. Ready for the updated premium?",
    );
    expect(g.asserted).toEqual(["driver_full_name", "vehicle_assignment", "effective_date", "premium_new_monthly_usd"]);
    expect(g.nextStep).toEqual({ kind: "none", field: null });
    expect(g.dropped).toEqual([]);
    expect(g.wordCount).toBe(39);
    expect(g.wordCount).toBeLessThanOrEqual(GREETING_MAX_WORDS);
  });

  it("the opening carries the AI disclosure and the recording notice in ≤ 14 words; the first fact comes by word 24", () => {
    const opening = greetingOpening(s01);
    expect(wordsIn(opening)).toBeLessThanOrEqual(GREETING_OPENING_MAX_WORDS);
    for (const re of GREETING_DISCLOSURE_RES) expect(opening).toMatch(re);
    const g = compileGreeting(handoffStateOf("s01"), s01);
    expect(g.text.split(/\s+/).indexOf("Maya")).toBeLessThan(24);
  });

  it("s02: effective_date PENDING ('tomorrow' = Saturday, September 26th) → no date clause, confirm it", () => {
    const g = compileGreeting(handoffStateOf("s02"), policyOf("s02"));
    expect(g.text).toContain("I'll finish adding Lucas to the 2014 Toyota Corolla, at $171 a month.");
    expect(g.text).toMatch(/Just to confirm, the change should start Saturday, September 26th\?$/);
    expect(g.wordCount).toBeLessThanOrEqual(GREETING_MAX_WORDS);
    expect(g.confirms).toBe("effective_date");
    expect(g.asserted).not.toContain("effective_date");
  });

  it("s05: license_state MISSING → ask which state issued Owen's license", () => {
    const g = compileGreeting(handoffStateOf("s05"), policyOf("s05"));
    expect(g.text).toMatch(/I just need which state issued Owen's license\.$/);
    expect(g.asks).toBe("license_state");
    expect(g.text).not.toMatch(/Illinois|Wisconsin/);
  });
});

describe("compileGreeting: rules", () => {
  it("the premium clause needs a VERIFIED premium stated by the REP", () => {
    const base: Partial<Record<FieldId, FieldSpec>> = { driver_full_name: { status: "VERIFIED", value: "maya raman" } };
    const byCustomer = compileGreeting(stateOf(s01, { ...base, premium_new_monthly_usd: { status: "VERIFIED", value: "142.00", source: "customer" } }), s01);
    expect(byCustomer.text).not.toContain("$142");
    const pending = compileGreeting(stateOf(s01, { ...base, premium_new_monthly_usd: { status: "PENDING", value: "142.00", source: "rep" } }), s01);
    expect(pending.text).not.toContain("$142");
    const byRep = compileGreeting(stateOf(s01, { ...base, premium_new_monthly_usd: { status: "VERIFIED", value: "142.00", source: "rep" } }), s01);
    expect(byRep.text).toContain("at $142 a month");
  });

  it("confirms the first PENDING field in priority order, before any MISSING ask", () => {
    const st = stateOf(s01, {
      driver_full_name: { status: "VERIFIED", value: "maya raman" },
      garaging_zip: { status: "PENDING", value: "44107" },
      driver_dob: { status: "PENDING", value: "2009-03-14" },
    });
    const g = compileGreeting(st, s01);
    expect(g.confirms).toBe("driver_dob");
    expect(g.text).toContain("Just to confirm, Maya's date of birth is March 14th, 2009?");
    expect(g.text).not.toContain("4 4 1 0 7");
  });

  it("an unverified name is never used as {d}; an unverified vehicle becomes 'the car'", () => {
    const st = stateOf(s01, {
      driver_full_name: { status: "PENDING", value: "maya raman" },
      vehicle_assignment: { status: "MISSING" },
      operator_type: { status: "PENDING", value: "primary" },
    });
    const g = compileGreeting(st, s01);
    expect(g.text).toContain("I'll finish adding a new driver.");
    expect(g.text).toContain("Just to confirm, the new driver's name is Maya Raman?");
    const g2 = compileGreeting(stateOf(s01, { operator_type: { status: "PENDING", value: "occasional" } }), s01);
    expect(g2.text).toContain("the new driver will be the occasional driver of the car");
  });

  it("the length cap drops the date clause, then the vehicle clause, then the premium clause", () => {
    const facts = {
      driver_full_name: { status: "VERIFIED", value: "maya raman" },
      vehicle_assignment: { status: "VERIFIED", value: "veh1" },
      effective_date: { status: "VERIFIED", value: "2026-10-02" },
      premium_new_monthly_usd: { status: "VERIFIED", value: "142.00", source: "rep" },
    } as const satisfies Partial<Record<FieldId, FieldSpec>>;
    // A long free-text PENDING value: every droppable clause goes (free text can still overflow; lint G2 checks samples).
    const st = stateOf(s01, { ...facts, incidents_3y: { status: "PENDING", value: "one speeding ticket last spring and a minor parking lot fender bender" } });
    const g = compileGreeting(st, s01);
    expect(g.dropped).toEqual(["date", "vehicle", "premium"]);
    expect(g.asserted).toEqual(["driver_full_name"]);
    expect(g.text).not.toMatch(/October 2nd|\$142/);
    expect(g.text).toContain("I'll finish adding Maya.");
    // Date and vehicle go; the premium stays.
    const g2 = compileGreeting(stateOf(s01, { ...facts, incidents_3y: { status: "PENDING", value: "a ticket" } }), s01);
    expect(g2.dropped).toEqual(["date", "vehicle"]);
    expect(g2.asserted).toEqual(["driver_full_name", "premium_new_monthly_usd"]);
    expect(g2.wordCount).toBeLessThanOrEqual(GREETING_MAX_WORDS);
    // Only the date goes.
    const { premium_new_monthly_usd: _p, ...noPremium } = facts;
    const g3 = compileGreeting(stateOf(s01, { ...noPremium, driver_dob: { status: "PENDING", value: "2009-03-14" } }), s01);
    expect(g3.dropped).toEqual(["date"]);
    expect(g3.text).toContain("2021 Honda Civic");
    expect(g3.asserted).toEqual(["driver_full_name", "vehicle_assignment"]);
    expect(g3.wordCount).toBeLessThanOrEqual(GREETING_MAX_WORDS);
  });

  it("'all' vehicles, relation words from the display, no MISSING premium asks", () => {
    const st = stateOf(s01, {
      driver_full_name: { status: "VERIFIED", value: "maya raman" },
      vehicle_assignment: { status: "VERIFIED", value: "all" },
      driver_relation: { status: "PENDING", value: "child", display: "child (daughter)" },
    });
    const g = compileGreeting(st, s01);
    expect(g.text).toContain("I'll finish adding Maya to all your vehicles.");
    expect(g.text).toContain("Just to confirm, Maya is your daughter?");
    const onlyPremiumMissing = compileGreeting(handoffStateOf("s01"), s01);
    expect(onlyPremiumMissing.asks).toBeNull();
  });

  it("the invariant check rejects a forged result", () => {
    const st = stateOf(s01, { driver_dob: { status: "PENDING", value: "2009-03-14" } });
    expect(() => assertGreetingInvariant({ asserted: ["driver_dob"], confirms: null, text: "AI assistant not a person recorded" }, st)).toThrow(/not VERIFIED/);
    expect(() => assertGreetingInvariant({ asserted: [], confirms: "garaging_zip", text: "AI assistant not a person recorded" }, st)).toThrow(/not PENDING/);
    expect(() => assertGreetingInvariant({ asserted: [], confirms: null, text: "hello" }, st)).toThrow(/disclosure/);
  });
});

describe("compileGreeting: six canonical states (snapshots)", () => {
  const long: PolicyRecord = { ...s01, agencyName: "Harborview Insurance Agency of Greater Cleveland and the Western Reserve" };
  const cases: [string, CaseState, PolicyRecord][] = [
    ["s01 all verified", handoffStateOf("s01"), s01],
    ["s02 pending date", handoffStateOf("s02"), policyOf("s02")],
    ["s05 missing license state", handoffStateOf("s05"), policyOf("s05")],
    ["nothing known", stateOf(s01, {}), s01],
    ["pending name, verified vehicle", stateOf(s01, {
      driver_full_name: { status: "PENDING", value: "maya" },
      vehicle_assignment: { status: "VERIFIED", value: "veh2" },
    }), s01],
    ["long agency and pending incidents (cap)", stateOf(long, {
      driver_full_name: { status: "VERIFIED", value: "maya raman" },
      vehicle_assignment: { status: "VERIFIED", value: "veh1" },
      effective_date: { status: "VERIFIED", value: "2026-10-02" },
      incidents_3y: { status: "PENDING", value: "one speeding ticket in 2024" },
    }), long],
  ];
  for (const [name, st, pol] of cases) {
    it(name, () => {
      const g = compileGreeting(st, pol);
      for (const re of GREETING_DISCLOSURE_RES) expect(g.text).toMatch(re);
      expect(g.wordCount).toBeLessThanOrEqual(GREETING_MAX_WORDS);
      expect(g).toMatchSnapshot();
    });
  }
});

// ------------------------------------------------------------------------------------------ property test

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NAMES = ["maya raman", "lucas delgado", "owen palmer", "ana lopez", "ravi shah", "zoe", "kwame mensah"];
const INCIDENTS = ["none", "one speeding ticket in 2024", "a minor fender bender"];

function randomState(rnd: () => number, policy: PolicyRecord): CaseState {
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
  const status = (): FieldStatus => pick(["VERIFIED", "VERIFIED", "PENDING", "MISSING"] as const);
  const year = 1950 + Math.floor(rnd() * 59); // 1950..2008: never a vehicle model year
  const dob = `${year}-${String(1 + Math.floor(rnd() * 12)).padStart(2, "0")}-${String(1 + Math.floor(rnd() * 28)).padStart(2, "0")}`;
  const values: Partial<Record<FieldId, string>> = {
    driver_full_name: pick(NAMES),
    driver_relation: pick(RELATIONS),
    driver_dob: dob,
    license_state: pick(US_STATES),
    license_status: pick(LICENSE_STATUSES),
    incidents_3y: pick(INCIDENTS),
    vehicle_assignment: pick(["veh1", "veh2", "all"]),
    operator_type: pick(OPERATOR_TYPES),
    garaging_zip: String(10000 + Math.floor(rnd() * 89999)),
    effective_date: addDays(policy.callDate, Math.floor(rnd() * 61)),
    premium_new_monthly_usd: `${50 + Math.floor(rnd() * 250)}.00`,
  };
  const spec: Partial<Record<FieldId, FieldSpec>> = {};
  for (const [f, v] of Object.entries(values) as [FieldId, string][]) {
    const s = status();
    const source: Party = f === "premium_new_monthly_usd" ? pick(["rep", "customer"] as const) : pick(["rep", "customer", "ai"] as const);
    spec[f] = { status: s, value: s === "MISSING" ? null : v, source };
  }
  return stateOf(policy, spec);
}

/** Distinctive spoken forms a field's value would take in the greeting. */
function formsIn(f: FieldId, v: string, policy: PolicyRecord): string[] {
  switch (f) {
    case "driver_full_name": return [firstNameOf(v)];
    case "driver_dob": return [spokenDob(v)];
    case "effective_date": return [spokenDate(v)];
    case "license_state": return [stateName(v)];
    case "license_status": return [` a ${licenseWords(v)}`];
    case "incidents_3y": return [v === "none" ? "no tickets or accidents" : v];
    case "vehicle_assignment": return [vehicleLabelOf(policy, v)];
    case "operator_type": return [`the ${v} driver`];
    case "garaging_zip": return [v, spokenZip(v)];
    case "premium_new_monthly_usd": return [spokenMoney(v)];
    case "driver_relation": return [];
    default: return [v];
  }
}

describe("compileGreeting: property test (500 random states)", () => {
  it("asserts only VERIFIED values plus at most one PENDING confirm value", () => {
    const rnd = mulberry32(20260925);
    const policies = [s01, policyOf("s05")];
    for (let i = 0; i < 500; i++) {
      const policy = policies[i % 2]!;
      const st = randomState(rnd, policy);
      const g = compileGreeting(st, policy);
      const ctx = `#${i}: ${g.text}`;
      for (const re of GREETING_DISCLOSURE_RES) expect(g.text, ctx).toMatch(re);
      expect(g.wordCount, ctx).toBeLessThanOrEqual(GREETING_MAX_WORDS);
      for (const f of g.asserted) expect(st.fields[f].status, ctx).toBe("VERIFIED");
      const firstPending = GREETING_PRIORITY.find((f) => st.fields[f].status === "PENDING") ?? null;
      expect(g.confirms, ctx).toBe(firstPending);
      if (g.confirms) expect(st.fields[g.confirms].status, ctx).toBe("PENDING");
      const nextSentences = (g.text.match(/Just to confirm|I just need|Ready for the updated premium/g) ?? []).length;
      expect(nextSentences, ctx).toBe(1);
      // No non-VERIFIED value may appear, except the one confirm clause.
      for (const f of Object.keys(st.fields) as FieldId[]) {
        const fs = st.fields[f];
        if (fs.status === "VERIFIED" || fs.value === null || f === g.confirms) continue;
        for (const form of formsIn(f, fs.value, policy)) expect(g.text.includes(form), `${ctx}\n  leaked ${f}=${fs.value} as "${form}"`).toBe(false);
      }
      // A VERIFIED premium from the customer is never spoken either.
      const prem = st.fields.premium_new_monthly_usd;
      if (prem.value && !(prem.status === "VERIFIED" && prem.source === "rep")) expect(g.text.includes(spokenMoney(prem.value)), ctx).toBe(false);
      expect(compileGreeting(st, policy)).toEqual(g); // deterministic
    }
  });
});

describe("compileGreetingV1 (naive)", () => {
  it("asserts every known value, including PENDING ones", () => {
    const g = compileGreetingV1(handoffStateOf("s02"), policyOf("s02"));
    expect(g.text).toContain("starting Saturday, September 26th");
    expect(g.asserted).toContain("effective_date");
    expect(g.text).toContain("I also have that");
    expect(g.wordCount).toBeGreaterThan(GREETING_MAX_WORDS); // v1 has no cap (why v3's rules matter)
    expect(g.nextStep.kind).toBe("none");
    const g5 = compileGreetingV1(handoffStateOf("s05"), policyOf("s05"));
    expect(g5.asks).toBe("license_state");
    const empty = compileGreetingV1(stateOf(s01, {}), s01);
    expect(empty.asserted).toEqual([]);
    expect(empty.text).toContain("to add a new driver.");
    const all = compileGreetingV1(stateOf(s01, { vehicle_assignment: { status: "PENDING", value: "all" } }), s01);
    expect(all.text).toContain("on all your vehicles");
  });
});
