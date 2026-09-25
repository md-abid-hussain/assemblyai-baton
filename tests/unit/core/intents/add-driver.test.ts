import { describe, expect, it } from "vitest";
import type { FieldId, PolicyRecord } from "../../../../src/core/contracts";
import {
  askPhrase, compatible, confirmPhrase, displayValue, effectiveDateInRange, firstNameOf, licenseAdjective, mergeValues,
  normalizeField, parseMoney, relationWord, resolveRelativeDate, spokenForms, targetedFields, vehicleLabelOf,
} from "../../../../src/core/intents/add-driver";
import { FIELD_IDS } from "../../../../src/core/intents/add-driver.fields";
import { policyOf, truthOf } from "../case/_fixtures";

const s01 = policyOf("s01");
const s02 = policyOf("s02");
const s05 = policyOf("s05");
const n = (field: FieldId, raw: string | number | null, policy: PolicyRecord = s01, callDate = policy.callDate) =>
  normalizeField(field, raw, { policy, callDate })?.norm ?? null;

describe("resolveRelativeDate (§5.4.1, shared with confirm_effective_date)", () => {
  it("'this Friday' from Monday 2026-09-28 → 2026-10-02", () => {
    expect(resolveRelativeDate("this Friday", "2026-09-28")).toBe("2026-10-02");
    expect(resolveRelativeDate("Friday", "2026-09-28")).toBe("2026-10-02");
    expect(resolveRelativeDate("next Friday", "2026-09-28")).toBe("2026-10-09");
  });
  it("from the call date Friday 2026-09-25", () => {
    const d = "2026-09-25";
    expect(resolveRelativeDate("tomorrow", d)).toBe("2026-09-26");
    expect(resolveRelativeDate("yeah, starting tomorrow works", d)).toBe("2026-09-26");
    expect(resolveRelativeDate("the day after tomorrow", d)).toBe("2026-09-27");
    expect(resolveRelativeDate("today", d)).toBe(d);
    expect(resolveRelativeDate("next Friday, October 2nd", d)).toBe("2026-10-02");
    expect(resolveRelativeDate("next Friday", d)).toBe("2026-10-02");
    expect(resolveRelativeDate("this Friday", d)).toBe(d);
    expect(resolveRelativeDate("on Friday", d)).toBe("2026-10-02");
    expect(resolveRelativeDate("Friday next week", d)).toBe("2026-10-02");
    expect(resolveRelativeDate("Monday", d)).toBe("2026-09-28");
    expect(resolveRelativeDate("in two weeks", d)).toBe("2026-10-09");
    expect(resolveRelativeDate("in 3 days", d)).toBe("2026-09-28");
    expect(resolveRelativeDate("next week", d)).toBe("2026-10-02");
    expect(resolveRelativeDate("first of next month", d)).toBe("2026-10-01");
    expect(resolveRelativeDate("on the 30th", d)).toBe("2026-09-30");
    expect(resolveRelativeDate("the 3rd", d)).toBe("2026-10-03");
    expect(resolveRelativeDate("October second", d)).toBe("2026-10-02");
    expect(resolveRelativeDate("2026-10-02", d)).toBe("2026-10-02");
    expect(resolveRelativeDate("10/2", d)).toBe("2026-10-02");
    expect(resolveRelativeDate("10/02/26", d)).toBe("2026-10-02");
    expect(resolveRelativeDate("September 1st", d)).toBe("2027-09-01");
    expect(resolveRelativeDate("the 2nd of October", d)).toBe("2026-10-02");
    expect(resolveRelativeDate("December 1st, 2026", d)).toBe("2026-12-01");
    expect(resolveRelativeDate("whenever", d)).toBeNull();
    expect(resolveRelativeDate("February 30th", d)).toBeNull();
    expect(resolveRelativeDate("tomorrow", "not-a-date")).toBeNull();
    expect(resolveRelativeDate("first of next month", "2026-12-10")).toBe("2027-01-01");
    expect(resolveRelativeDate("on the 5th", "2026-12-10")).toBe("2027-01-05");
  });
});

describe("normalizeField: money (dollars with 2 decimals)", () => {
  it("'$142' / '142 dollars' / '14200 cents' / words", () => {
    for (const raw of ["$142", "142 dollars", "14200 cents", "142", "142.00", "$142 a month", "one hundred forty two dollars", "one hundred and forty-two dollars"]) {
      expect(n("premium_new_monthly_usd", raw), raw).toBe("142.00");
    }
    expect(n("premium_new_monthly_usd", 142)).toBe("142.00");
    expect(n("amount_due_today_usd", 34.1)).toBe("34.10");
    expect(n("amount_due_today_usd", "$34.10 due today")).toBe("34.10");
    expect(n("amount_due_today_usd", "thirty four dollars and ten cents")).toBe("34.10");
    expect(n("amount_due_today_usd", "$1,234.5")).toBe("1234.50");
    expect(n("amount_due_today_usd", "-5")).toBeNull();
    expect(n("amount_due_today_usd", "a lot")).toBeNull();
  });
  it("signed premium change", () => {
    expect(n("premium_change_monthly_usd", "-12.50")).toBe("-12.50");
    expect(n("premium_change_monthly_usd", "down $12.50")).toBe("-12.50");
    expect(n("premium_change_monthly_usd", "that's up $46 from your $96")).toBe("46.00");
    expect(n("premium_change_monthly_usd", "0")).toBe("0.00");
    expect(n("premium_change_monthly_usd", "-0")).toBe("0.00");
    expect(parseMoney("2k", false)).toBe("2000.00");
  });
});

describe("normalizeField: other kinds", () => {
  it("ZIP: 5 digits, spoken digits, ZIP+4 → first 5", () => {
    expect(n("garaging_zip", "44107")).toBe("44107");
    expect(n("garaging_zip", "it's parked at home, 44107")).toBe("44107");
    expect(n("garaging_zip", "4 4 1 0 7")).toBe("44107");
    expect(n("garaging_zip", "four four one oh seven")).toBe("44107");
    expect(n("garaging_zip", "44107-1234")).toBe("44107");
    expect(n("garaging_zip", "4410")).toBeNull();
    expect(n("garaging_zip", "441071")).toBeNull();
  });

  it("relationship synonyms", () => {
    const cases: [string, string | null][] = [
      ["my daughter", "child"], ["son", "child"], ["our kid", "child"], ["child", "child"], ["wife", "spouse"], ["husband", "spouse"],
      ["partner", "domestic_partner"], ["domestic partner", "domestic_partner"], ["stepdaughter", "stepchild"], ["step son", "stepchild"],
      ["my mom", "parent"], ["dad", "parent"], ["brother", "sibling"], ["sister", "sibling"], ["niece", "other_relative"],
      ["nephew", "other_relative"], ["cousin", "other_relative"], ["grandchild", "other_relative"], ["granddaughter", "other_relative"],
      ["roommate", "non_relative_resident"], ["boyfriend who lives with us", "non_relative_resident"],
      ["girlfriend, she doesn't live with us", "non_relative_nonresident"], ["our nanny", "non_relative_nonresident"],
      ["nanny who lives with us", "non_relative_resident"], ["non_relative_resident", "non_relative_resident"],
      ["non relative nonresident", "non_relative_nonresident"], ["friend", null], ["the neighbor", null],
    ];
    for (const [raw, want] of cases) expect(n("driver_relation", raw), raw).toBe(want);
  });

  it("vehicle matching: unique model/make/year, ambiguous → null, id, all", () => {
    expect(n("vehicle_assignment", "the Civic")).toBe("veh1");
    expect(n("vehicle_assignment", "Honda")).toBe("veh1");
    expect(n("vehicle_assignment", "the 2018 one")).toBe("veh2");
    expect(n("vehicle_assignment", "Highlander")).toBe("veh2");
    expect(n("vehicle_assignment", "veh2")).toBe("veh2");
    expect(n("vehicle_assignment", "veh9")).toBeNull();
    expect(n("vehicle_assignment", "both")).toBe("all");
    expect(n("vehicle_assignment", "all of the cars")).toBe("all");
    expect(n("vehicle_assignment", "the Tesla")).toBeNull();
    expect(n("vehicle_assignment", "the Corolla", s02)).toBe("veh2");
    expect(n("vehicle_assignment", "the F-150", s02)).toBe("veh1");
    expect(n("vehicle_assignment", "his F150", s02)).toBe("veh1");
    expect(n("vehicle_assignment", "the Chevy", s05)).toBe("veh1");
    const twoToyotas: PolicyRecord = { ...s05, vehicles: [
      { id: "veh1", year: 2019, make: "Toyota", model: "Tacoma", label: "2019 Toyota Tacoma" },
      { id: "veh2", year: 2012, make: "Toyota", model: "Camry", label: "2012 Toyota Camry" },
    ] };
    expect(n("vehicle_assignment", "the Toyota", twoToyotas)).toBeNull();
    expect(n("vehicle_assignment", "the Toyota Camry", twoToyotas)).toBe("veh2");
  });

  it("names: letters only, spelled letters dropped; subset compatibility; merge keeps the longer", () => {
    expect(n("driver_full_name", "Maya Raman, M-A-Y-A")).toBe("maya raman");
    expect(n("driver_full_name", "  Mary-Jane  O'Neil ")).toBe("mary-jane o'neil");
    expect(n("driver_full_name", "123")).toBeNull();
    expect(compatible("driver_full_name", "maya", "maya raman")).toBe(true);
    expect(compatible("driver_full_name", "maya raman", "maya")).toBe(true);
    expect(compatible("driver_full_name", "maya", "mia raman")).toBe(false);
    expect(compatible("garaging_zip", "44107", "44107")).toBe(true);
    expect(compatible("garaging_zip", "44107", "44108")).toBe(false);
    expect(compatible("garaging_zip", null, "44108")).toBe(false);
    expect(mergeValues("driver_full_name", "maya", "maya raman")).toBe("maya raman");
    expect(mergeValues("driver_full_name", "maya raman", "maya")).toBe("maya raman");
    expect(mergeValues("driver_full_name", "ann lee", "anna lee")).toBe("anna lee");
    expect(mergeValues("garaging_zip", "44107", "44107")).toBe("44107");
    expect(displayValue("driver_full_name", "mary-jane o'neil", s01)).toBe("Mary-Jane O'Neil");
    expect(firstNameOf("maya raman")).toBe("Maya");
  });

  it("dates of birth: past, year ≥ 1920, at least 14 years old", () => {
    expect(n("driver_dob", "March 14th, 2009")).toBe("2009-03-14");
    expect(n("driver_dob", "2009-03-14")).toBe("2009-03-14");
    expect(n("driver_dob", "03/14/2009")).toBe("2009-03-14");
    expect(n("driver_dob", "March fourteenth, two thousand nine")).toBe("2009-03-14");
    expect(n("driver_dob", "14 March 2009")).toBe("2009-03-14");
    expect(n("driver_dob", "2020-01-01")).toBeNull();
    expect(n("driver_dob", "1900-01-01")).toBeNull();
    expect(n("driver_dob", "2030-01-01")).toBeNull();
    expect(n("driver_dob", "no idea")).toBeNull();
  });

  it("age, state, license status/number, incidents, operator, discounts, underwriting, coverage", () => {
    expect(n("driver_age", "seventeen")).toBe("17");
    expect(n("driver_age", "she's 17")).toBe("17");
    expect(n("driver_age", 5)).toBeNull();
    expect(n("driver_age", "old")).toBeNull();
    expect(n("license_state", "Ohio")).toBe("OH");
    expect(n("license_state", "OH")).toBe("OH");
    expect(n("license_state", "oh")).toBe("OH");
    expect(n("license_state", "from Wisconsin")).toBe("WI");
    expect(n("license_state", "West Virginia")).toBe("WV");
    expect(n("license_state", "Washington D.C.")).toBe("DC");
    expect(n("license_state", "licensed in NY")).toBe("NY");
    expect(n("license_state", "out of state")).toBeNull();
    expect(n("license_state", "somewhere")).toBeNull();
    expect(n("license_status", "probationary")).toBe("provisional");
    expect(n("license_status", "her junior license")).toBe("provisional");
    expect(n("license_status", "learner's permit")).toBe("learner_permit");
    expect(n("license_status", "learner permit")).toBe("learner_permit");
    expect(n("license_status", "full")).toBe("full");
    expect(n("license_status", "a regular license")).toBe("full");
    expect(n("license_status", "yes")).toBeNull();
    expect(n("license_number", "a1b 234-567")).toBe("A1B234567");
    expect(n("license_number", "--")).toBeNull();
    expect(n("incidents_3y", "no tickets, nothing")).toBe("none");
    expect(n("incidents_3y", "nothing, he's brand new")).toBe("none");
    expect(n("incidents_3y", "clean record")).toBe("none");
    expect(n("incidents_3y", "None.")).toBe("none");
    expect(n("incidents_3y", "No accidents but one speeding ticket")).toBe("no accidents but one speeding ticket");
    expect(n("incidents_3y", "One speeding ticket last year")).toBe("one speeding ticket last year");
    expect(n("operator_type", "she'll drive it every day to school")).toBe("primary");
    expect(n("operator_type", "primary")).toBe("primary");
    expect(n("operator_type", "just on weekends")).toBe("occasional");
    expect(n("operator_type", "maybe")).toBeNull();
    expect(n("good_student_discount", "eligible")).toBe("eligible");
    expect(n("good_student_discount", "pending proof")).toBe("pending_proof");
    expect(n("good_student_discount", "she'll send the report card")).toBe("pending_proof");
    expect(n("mature_driver_discount", "doesn't qualify")).toBe("not_eligible");
    expect(n("driver_training_discount", "yes, it applies")).toBe("eligible");
    expect(n("distant_student_discount", "hmm")).toBeNull();
    expect(n("underwriting_review", "true")).toBe("true");
    expect(n("underwriting_review", "it needs underwriting review")).toBe("true");
    expect(n("underwriting_review", "no")).toBe("false");
    expect(n("underwriting_review", "maybe")).toBeNull();
    expect(n("coverage_change", " Keep  current limits ")).toBe("keep current limits");
    expect(n("coverage_change", null)).toBeNull();
    expect(n("coverage_change", "  ")).toBeNull();
  });

  it("effective dates normalize even out of range; the range helper flags them", () => {
    expect(n("effective_date", "December 1st")).toBe("2026-12-01");
    expect(effectiveDateInRange("2026-12-25", "2026-09-25")).toBe(false); // 91 days
    expect(effectiveDateInRange("2026-12-18", "2026-09-25")).toBe(true); // s07's designed VERIFIED date (84 days)
    expect(effectiveDateInRange("2026-12-01", "2026-09-25", 60)).toBe(false);
    expect(effectiveDateInRange("2026-09-24", "2026-09-25")).toBe(false);
    expect(effectiveDateInRange("junk", "2026-09-25")).toBe(true);
  });

  it("kit truth values normalize to themselves (norm format = kit value format)", () => {
    for (const id of ["s01", "s02", "s05"]) {
      const truth = truthOf(id);
      const policy = policyOf(id);
      for (const [f, v] of Object.entries(truth) as [FieldId, string][]) expect(n(f, v, policy), `${id}.${f}`).toBe(v);
    }
  });
});

describe("display values", () => {
  it("per kind", () => {
    const d = (f: FieldId, v: string, raw?: string) => displayValue(f, v, s01, raw);
    expect(d("driver_dob", "2009-03-14")).toBe("March 14th, 2009");
    expect(d("driver_relation", "child", "my daughter")).toBe("child (daughter)");
    expect(d("driver_relation", "child")).toBe("child");
    expect(d("driver_relation", "non_relative_resident")).toBe("non relative resident");
    expect(d("license_state", "OH")).toBe("Ohio (OH)");
    expect(d("license_state", "XX")).toBe("XX");
    expect(d("license_status", "provisional")).toBe("probationary license");
    expect(d("license_number", "A1B2")).toBe("A 1 B 2");
    expect(d("incidents_3y", "none")).toBe("none");
    expect(d("incidents_3y", "one ticket", "One ticket")).toBe("One ticket");
    expect(d("incidents_3y", "one ticket")).toBe("one ticket");
    expect(d("vehicle_assignment", "veh1")).toBe("2021 Honda Civic");
    expect(d("vehicle_assignment", "all")).toBe("all your vehicles");
    expect(d("effective_date", "2026-10-02")).toBe("Friday, October 2nd");
    expect(d("good_student_discount", "pending_proof")).toBe("pending proof");
    expect(d("coverage_change", "keep limits", "Keep limits")).toBe("Keep limits");
    expect(d("coverage_change", "keep limits")).toBe("keep limits");
    expect(d("premium_new_monthly_usd", "142.00")).toBe("$142 a month");
    expect(d("premium_change_monthly_usd", "-12.50")).toBe("-$12.50 a month");
    expect(d("amount_due_today_usd", "34.10")).toBe("$34.10");
    for (const f of FIELD_IDS) expect(typeof displayValue(f, "x", s01)).toBe("string");
    expect(vehicleLabelOf(s01, "veh7")).toBe("veh7");
    expect(licenseAdjective("provisional")).toBe("probationary");
    expect(licenseAdjective("weird_one")).toBe("weird one");
    expect(relationWord("weird_rel")).toBe("weird rel");
  });
});

describe("phrase table (§5.6)", () => {
  const pc = { policy: s01, d: "Maya", vehicleLabel: "2021 Honda Civic" };
  it("confirmPhrase", () => {
    expect(confirmPhrase("driver_full_name", "maya raman", pc)).toBe("the new driver's name is Maya Raman");
    expect(confirmPhrase("driver_relation", "child", { ...pc, raw: "child (daughter)" })).toBe("Maya is your daughter");
    expect(confirmPhrase("driver_relation", "spouse", pc)).toBe("Maya is your spouse");
    expect(confirmPhrase("driver_relation", "non_relative_resident", pc)).toBe("Maya is not related to you but lives with you");
    expect(confirmPhrase("driver_relation", "non_relative_resident", { ...pc, raw: "roommate" })).toBe("Maya is your roommate");
    expect(confirmPhrase("driver_relation", "non_relative_nonresident", pc)).toBe("Maya is not related to you and doesn't live with you");
    expect(confirmPhrase("driver_dob", "2009-03-14", pc)).toBe("Maya's date of birth is March 14th, 2009");
    expect(confirmPhrase("license_state", "OH", pc)).toBe("Maya's license is from Ohio");
    expect(confirmPhrase("license_status", "provisional", pc)).toBe("Maya has a probationary license");
    expect(confirmPhrase("incidents_3y", "none", pc)).toBe("Maya has had no tickets or accidents in the last three years");
    expect(confirmPhrase("incidents_3y", "one ticket", pc)).toBe("Maya has had the following in the last three years: one ticket");
    expect(confirmPhrase("vehicle_assignment", "veh1", pc)).toBe("Maya will mainly drive the 2021 Honda Civic");
    expect(confirmPhrase("vehicle_assignment", "all", pc)).toBe("Maya will drive all your vehicles");
    expect(confirmPhrase("operator_type", "primary", pc)).toBe("Maya will be the primary driver of the 2021 Honda Civic");
    expect(confirmPhrase("garaging_zip", "44107", pc)).toBe("the car is kept at ZIP code 4 4 1 0 7");
    expect(confirmPhrase("effective_date", "2026-10-02", pc)).toBe("the change should start Friday, October 2nd");
    expect(confirmPhrase("license_number", "A12", pc)).toBe("Maya's license number is A 1 2");
    expect(confirmPhrase("driver_age", "17", pc)).toBe("Maya is 17");
    expect(confirmPhrase("good_student_discount", "eligible", pc)).toBe("the good-student discount is eligible");
  });
  it("askPhrase", () => {
    const d = { ...pc, d: "the new driver", vehicleLabel: null };
    expect(askPhrase("driver_full_name", d)).toBe("the new driver's full name");
    expect(askPhrase("driver_relation", d)).toBe("how the new driver is related to you");
    expect(askPhrase("driver_dob", d)).toBe("the new driver's date of birth");
    expect(askPhrase("license_state", pc)).toBe("which state issued Maya's license");
    expect(askPhrase("license_status", pc)).toBe("whether Maya has a learner's permit, a probationary license or a full license");
    expect(askPhrase("incidents_3y", pc)).toBe("whether Maya has had any tickets or accidents in the last three years");
    expect(askPhrase("vehicle_assignment", pc)).toBe("which car Maya will mainly drive");
    expect(askPhrase("operator_type", pc)).toBe("whether Maya will drive the 2021 Honda Civic every day or just occasionally");
    expect(askPhrase("operator_type", d)).toBe("whether the new driver will drive the car every day or just occasionally");
    expect(askPhrase("garaging_zip", pc)).toBe("the ZIP code where the car is kept overnight");
    expect(askPhrase("effective_date", pc)).toBe("the date you'd like this change to start");
    expect(askPhrase("license_number", pc)).toBe("Maya's license number");
    expect(askPhrase("coverage_change", pc)).toBe("the coverage change");
  });
});

describe("QA lexicon and spoken forms (§5.13)", () => {
  it("targetedFields: strong patterns win over generic words", () => {
    expect(targetedFields("What's the ZIP code where the car is kept overnight?")).toEqual(["garaging_zip"]);
    expect(targetedFields("Which state issued her license?")).toEqual(["license_state"]);
    expect(targetedFields("Is it a probationary license?")).toEqual(["license_status"]);
    expect(targetedFields("What's her license number?")).toEqual(["license_number"]);
    expect(targetedFields("Does she have a license yet?")).toEqual(["license_status"]);
    expect(targetedFields("Which car will she mainly drive?")).toEqual(["vehicle_assignment"]);
    expect(targetedFields("Is that the car?")).toEqual(["vehicle_assignment"]);
    expect(targetedFields("What's her date of birth?")).toEqual(["driver_dob"]);
    expect(targetedFields("Can you spell her last name?")).toEqual(["driver_full_name"]);
    expect(targetedFields("When would you like this to start?")).toEqual(["effective_date"]);
    expect(targetedFields("Any tickets or accidents?")).toEqual(["incidents_3y"]);
    expect(targetedFields("How is she related to you?")).toEqual(["driver_relation"]);
    expect(targetedFields("Will she drive it every day?")).toEqual(["operator_type"]);
    expect(targetedFields("Thanks!")).toEqual([]);
  });
  it("spokenForms per kind", () => {
    expect(spokenForms("driver_full_name", "maya raman", s01)).toEqual(["Maya Raman", "Maya"]);
    expect(spokenForms("driver_dob", "2009-03-14", s01)).toEqual(["March 14th, 2009", "March 14th", "2009"]);
    expect(spokenForms("effective_date", "2026-10-02", s01)).toEqual(["Friday, October 2nd", "October 2nd", "Friday"]);
    expect(spokenForms("effective_date", "soon", s01)).toEqual(["soon"]);
    expect(spokenForms("garaging_zip", "44107", s01)).toEqual(["44107", "4 4 1 0 7"]);
    expect(spokenForms("vehicle_assignment", "veh1", s01)).toEqual(["Civic", "2021 Honda Civic", "Honda Civic"]);
    expect(spokenForms("vehicle_assignment", "all", s01)).toEqual(["all"]);
    expect(spokenForms("driver_relation", "child", s01)).toContain("daughter");
    expect(spokenForms("driver_relation", "weird", s01)).toEqual(["weird"]);
    expect(spokenForms("license_state", "OH", s01)).toEqual(["Ohio"]);
    expect(spokenForms("license_status", "provisional", s01)).toContain("probationary");
    expect(spokenForms("license_status", "learner_permit", s01)).toContain("permit");
    expect(spokenForms("license_status", "full", s01)).toContain("full license");
    expect(spokenForms("license_status", "x", s01)).toEqual(["x"]);
    expect(spokenForms("license_number", "A12", s01)).toEqual(["A12", "A 1 2"]);
    expect(spokenForms("incidents_3y", "none", s01)).toContain("no tickets");
    expect(spokenForms("incidents_3y", "one ticket", s01)).toEqual(["one ticket"]);
    expect(spokenForms("operator_type", "primary", s01)).toContain("every day");
    expect(spokenForms("operator_type", "occasional", s01)).toContain("occasionally");
    expect(spokenForms("driver_age", "17", s01)).toEqual(["17"]);
    expect(spokenForms("premium_new_monthly_usd", "142.00", s01)).toEqual(["$142"]);
    expect(spokenForms("good_student_discount", "pending_proof", s01)).toEqual(["pending proof"]);
  });
});
