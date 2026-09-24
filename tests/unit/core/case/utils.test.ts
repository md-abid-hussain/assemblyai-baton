import { describe, expect, it } from "vitest";
import { RawPatchSchema } from "../../../../src/core/contracts";
import {
  addDays, ageOn, dayNumber, daysInMonth, diffDays, fromDayNumber, isIsoDate, parseExplicitDate, weekdayOf, ymd,
} from "../../../../src/core/case/dates";
import {
  ADD_DRIVER_PATCH_FORMAT, EXTRACTOR_PROMPT_V1, EXTRACTOR_PROMPT_V3, EXTRACTOR_VERSION_V1, EXTRACTOR_VERSION_V3, buildExtractorInput,
  extractorVersionOf,
} from "../../../../src/core/case/extractor";
import { sha256Hex } from "../../../../src/core/case/sha256";
import { emptyCaseState } from "../../../../src/core/case/state";
import { collapseWs, containsRun, lcsLength, levenshtein, titleCase, wordTokens, wordsToNumbers } from "../../../../src/core/case/text";
import { FIELD_IDS } from "../../../../src/core/intents/add-driver.fields";
import { handoffStateOf, policyOf } from "./_fixtures";

describe("sha256 (NIST vectors)", () => {
  it("matches", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(sha256Hex("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")).toBe("248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1");
    expect(sha256Hex("a".repeat(1000))).toBe("41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3");
    expect(sha256Hex("é✓")).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("text helpers", () => {
  it("wordsToNumbers", () => {
    const w = (s: string) => wordsToNumbers(s);
    expect(w("four four one zero seven")).toBe("4 4 1 0 7");
    expect(w("one hundred and forty-two dollars")).toBe("142 dollars");
    expect(w("a hundred dollars")).toBe("100 dollars");
    expect(w("two thousand nine")).toBe("2009");
    expect(w("two thousand and twenty six")).toBe("2026");
    expect(w("twenty twenty six")).toBe("20 26");
    expect(w("nineteen hundred")).toBe("1900");
    expect(w("october second, please")).toBe("october 2, please");
    expect(w("the twenty-first")).toBe("the 21");
    expect(w("seventeen and a half")).toBe("17 and a half");
    expect(w("hundred thousand")).toBe("hundred thousand");
    expect(w("five thousand thousand")).toBe("5000 thousand");
    expect(w("one hundred five")).toBe("105");
    expect(w("twenty zero")).toBe("20 0");
    expect(w("nine ten")).toBe("9 10");
    expect(w("and one")).toBe("and 1");
    expect(w("a car")).toBe("a car");
    expect(w("the hundredth")).toBe("the hundredth");
  });
  it("tokens, distances, runs, casing", () => {
    expect(collapseWs("  a \n b ")).toBe("a b");
    expect(titleCase("mary-jane o'neil")).toBe("Mary-Jane O'Neil");
    expect(wordTokens("It’s 4.5 miles, Maya!")).toEqual(["it's", "4.5", "miles", "maya"]);
    expect(lcsLength(["a", "b", "c"], ["a", "x", "c"])).toBe(2);
    expect(lcsLength([], ["a"])).toBe(0);
    expect(levenshtein(["a", "b", "c"], ["a", "c"])).toBe(1);
    expect(containsRun(["a", "b", "c"], ["b", "c"])).toBe(true);
    expect(containsRun(["a", "b", "c"], ["c", "b"])).toBe(false);
    expect(containsRun(["a"], [])).toBe(true);
  });
});

describe("dates", () => {
  it("day arithmetic", () => {
    expect(dayNumber("2026-02-30")).toBeNull();
    expect(dayNumber("nope")).toBeNull();
    expect(isIsoDate("2024-02-29")).toBe(true);
    expect(isIsoDate("2023-02-29")).toBe(false);
    expect(daysInMonth(2024, 2)).toBe(29);
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(diffDays("2026-09-25", "2026-10-02")).toBe(7);
    expect(fromDayNumber(0)).toBe("1970-01-01");
    expect(weekdayOf("2026-09-25")).toBe(5);
    expect(ymd("2026-09-25")).toEqual({ y: 2026, m: 9, d: 25 });
    expect(() => ymd("2026-02-30")).toThrow(/invalid ISO date/);
    expect(ageOn("2009-03-14", "2026-09-25")).toBe(17);
    expect(ageOn("2009-09-26", "2026-09-25")).toBe(16);
    expect(ageOn("2009-09-25", "2026-09-25")).toBe(17);
  });
  it("parseExplicitDate: year-less dates resolve forward or backward", () => {
    expect(parseExplicitDate("March 14", "2026-09-25", "past")).toBe("2026-03-14");
    expect(parseExplicitDate("December 14", "2026-09-25", "past")).toBe("2025-12-14");
    expect(parseExplicitDate("March 14", "2026-09-25", "future")).toBe("2027-03-14");
    expect(parseExplicitDate("2026-13-01", "2026-09-25")).toBeNull();
    expect(parseExplicitDate("3/14/09", "2026-09-25")).toBe("2009-03-14");
    expect(parseExplicitDate("3/14/99", "2026-09-25")).toBe("1999-03-14");
    expect(parseExplicitDate("June 2nd, twenty ten", "2026-09-25")).toBe("2010-06-02");
    expect(parseExplicitDate("Feb 29", "2026-09-25", "past")).toBe(null);
    expect(parseExplicitDate("nothing here", "2026-09-25")).toBeNull();
  });
});

describe("extractor artefacts (§5.3)", () => {
  it("prompt text and strict schema", () => {
    expect(EXTRACTOR_PROMPT_V3).toMatch(/^You extract facts for an insurance policy-change case/);
    expect(EXTRACTOR_PROMPT_V3).toContain('If nothing relevant is said, return {"events": [], "no_facts": true}.');
    expect(EXTRACTOR_PROMPT_V3.endsWith("turn_id: the id of the NEW TURN the event comes from.")).toBe(true);
    expect(EXTRACTOR_PROMPT_V1).not.toContain("readback");
    expect(ADD_DRIVER_PATCH_FORMAT.name).toBe("add_driver_patch");
    const schema = ADD_DRIVER_PATCH_FORMAT.schema as { properties: { events: { items: { properties: { field: { enum: string[] } }; required: string[] } } } };
    expect(schema.properties.events.items.properties.field.enum).toEqual([...FIELD_IDS]);
    expect(schema.properties.events.items.required).toEqual(["turn_id", "field", "kind", "value", "quote", "acknowledges_turn_id", "confidence"]);
    expect(RawPatchSchema.parse({ no_facts: true, events: [] })).toEqual({ no_facts: true, events: [] });
  });
  it("version pin: 12 hex chars, stable, sensitive to every input", () => {
    expect(EXTRACTOR_VERSION_V3).toMatch(/^[0-9a-f]{12}$/);
    expect(EXTRACTOR_VERSION_V3).not.toBe(EXTRACTOR_VERSION_V1);
    expect(extractorVersionOf(EXTRACTOR_PROMPT_V3, ADD_DRIVER_PATCH_FORMAT, "gpt-6-luna", "none")).toBe(EXTRACTOR_VERSION_V3);
    expect(extractorVersionOf(EXTRACTOR_PROMPT_V3, ADD_DRIVER_PATCH_FORMAT, "gpt-6-luna", "low")).not.toBe(EXTRACTOR_VERSION_V3);
  });
  it("user input JSON (§5.3 example shape)", () => {
    const policy = policyOf("s01");
    const state = emptyCaseState("c");
    state.fields.driver_full_name = { ...state.fields.driver_full_name, status: "PENDING", value: "maya raman" };
    const recent = Array.from({ length: 8 }, (_, i) => ({ turnId: `rep-${i}`, channel: "rep" as const, text: `t${i}` }));
    const j = JSON.parse(buildExtractorInput({ callDate: "2026-09-25", policy, state, recent, newTurns: [{ turnId: "customer-9", channel: "customer", text: "Hi" }] })) as {
      call_date: string; call_weekday: string; policy: Record<string, unknown>; case: Record<string, unknown>; recent_turns: unknown[]; new_turns: unknown[];
    };
    expect(j.call_date).toBe("2026-09-25");
    expect(j.call_weekday).toBe("Friday");
    expect(j.policy).toEqual({
      policyholder: "Priya Raman", vehicles: [{ id: "veh1", label: "2021 Honda Civic" }, { id: "veh2", label: "2018 Toyota Highlander" }],
      address_zip: "44107", existing_drivers: ["Priya Raman", "Arun Raman"],
    });
    expect(j.case.driver_full_name).toEqual({ value: "maya raman", status: "PENDING" });
    expect(j.case.effective_date).toEqual({ value: null, status: "MISSING" });
    expect(j.case.driver_age).toBeUndefined();
    expect(Object.keys(j.case)).toHaveLength(10);
    expect(j.recent_turns).toHaveLength(6);
    expect(j.recent_turns[0]).toEqual({ turn_id: "rep-2", speaker: "REP", text: "t2" });
    expect(j.new_turns).toEqual([{ turn_id: "customer-9", speaker: "CUSTOMER", text: "Hi" }]);
    const full = JSON.parse(buildExtractorInput({ callDate: "2026-09-25", policy, state: handoffStateOf("s01"), recent: [], newTurns: [] })) as { case: Record<string, unknown> };
    expect(Object.keys(full.case).length).toBeGreaterThan(10);
  });
});
