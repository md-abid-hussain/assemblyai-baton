/**
 * scripts/relay/parity-corpus.ts - the Baton parity corpus (PLATFORM §4.6), built from the kit scenarios
 * (data/scenarios/*.json, read-only). WP14a. Used by `snapshot-legacy.ts` (the oracle); the parity tests read the
 * written fixtures, never this module, so the proof stays valid after the legacy code is deleted.
 *
 * Corpus (T2 scope; WP14a·3 extends it with QA and derive):
 * - s01, s02, s05 at 3 pass points each (the facts said by 1/3 and 2/3 of the talk track, and the planned hand-off);
 * - WP1's canonical greeting states and the 4 canned states (all verified, one pending, one missing, nothing);
 * - 200 seeded random snapshots: each of the 10 required fields independently VERIFIED, PENDING or MISSING, values
 *   drawn from the 22 scenarios, the premium from the rep or not, plus random optional fields;
 * - normalization inputs: every scenario fact's value and its `say_it` words.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { CaseState, FieldId, FieldState, FieldStatus, Party, PolicyRecord } from "../../src/core/contracts/case";
import { emptyCaseState, readinessOf } from "../../src/core/case/state";
import { normalizeField } from "../../src/core/intents/add-driver";
import { FIELD_IDS, REQUIRED_FIELDS } from "../../src/core/intents/add-driver.fields";
import type { BatonRating } from "../../src/core/relay/account";

export const ROOT = process.cwd();

interface KitFact { value: string | number | boolean; stated_by: "rep" | "customer"; status_at_handoff: FieldStatus; say_it?: string }
export interface KitScenario {
  id: string;
  call_date: string;
  rep: { name: string; agency: string };
  customer: {
    name: string; policy_number: string; carrier: string;
    address: { street: string; city: string; state: string; zip: string };
    existing_drivers: { name: string; relation: string }[];
    vehicles: { id: string; year: number; make: string; model: string }[];
    current_premium_monthly_usd: number;
  };
  facts: Partial<Record<FieldId, KitFact>>;
  talk_track: { n: number; who: string; beat: string; facts?: string[] }[];
}

export const SCENARIO_IDS: readonly string[] = readdirSync(join(ROOT, "data", "scenarios"))
  .filter((f) => /^s\d{2}\.json$/.test(f)).map((f) => f.slice(0, 3)).sort();

export const kitScenario = (id: string): KitScenario =>
  JSON.parse(readFileSync(join(ROOT, "data", "scenarios", `${id}.json`), "utf8")) as KitScenario;

/** The PolicyRecord WP9's normalizeScenario produces (phoneOnFileLast4 = the last 4 policy-number digits). */
export function policyOf(id: string): PolicyRecord {
  const s = kitScenario(id);
  const [first = "", ...rest] = s.customer.name.split(" ");
  const digits = s.customer.policy_number.replace(/\D/g, "");
  return {
    policyNumber: s.customer.policy_number,
    carrier: s.customer.carrier,
    agencyName: s.rep.agency,
    repFirstName: s.rep.name.split(" ")[0]!,
    policyholder: { firstName: first, lastName: rest.join(" ") },
    phoneOnFileLast4: digits.slice(-4),
    address: s.customer.address,
    existingDrivers: s.customer.existing_drivers,
    vehicles: s.customer.vehicles.map((v) => ({ id: v.id, year: v.year, make: v.make, model: v.model, label: `${v.year} ${v.make} ${v.model}` })),
    currentMonthlyPremiumUsd: s.customer.current_premium_monthly_usd,
    callDate: s.call_date,
  };
}

/** `Scenario.rating` from the kit facts (new monthly premium; due today when the kit states it). */
export function ratingOf(id: string): BatonRating & { dueTodayUsd: number | null } {
  const f = kitScenario(id).facts;
  return {
    newMonthlyUsd: Number(f.premium_new_monthly_usd?.value ?? kitScenario(id).customer.current_premium_monthly_usd),
    dueTodayUsd: f.amount_due_today_usd ? Number(f.amount_due_today_usd.value) : null,
  };
}

/** Normalized kit truth (all facts). */
export function truthOf(id: string): Partial<Record<FieldId, string>> {
  const s = kitScenario(id);
  const policy = policyOf(id);
  const out: Partial<Record<FieldId, string>> = {};
  for (const [f, fact] of Object.entries(s.facts) as [FieldId, KitFact][]) {
    const n = normalizeField(f, String(fact.value), { policy, callDate: s.call_date });
    if (n) out[f] = n.norm;
  }
  return out;
}

export interface FieldSpec { status: FieldStatus; value?: string | null; source?: Party | null }

/** A CaseState from per-field specs (values normalized; display from the legacy normalizer, as the pipeline does). */
export function stateOf(policy: PolicyRecord, spec: Partial<Record<FieldId, FieldSpec>>, caseId: string): CaseState {
  const st = emptyCaseState(caseId);
  for (const [f, s] of Object.entries(spec) as [FieldId, FieldSpec][]) {
    const value = s.status === "MISSING" ? null : (s.value ?? null);
    const display = value !== null ? (normalizeField(f, value, { policy, callDate: policy.callDate })?.display ?? value) : null;
    const fs: FieldState = {
      field: f, status: s.status,
      reason: s.status === "VERIFIED" ? "acknowledged" : s.status === "PENDING" ? "stated_once" : "absent",
      value, display, source: s.status === "MISSING" ? null : (s.source ?? "customer"),
      evidence: [], conflict: null, flags: [], updatedAtMs: 0,
    };
    st.fields[f] = fs;
  }
  st.readiness = readinessOf(st.fields);
  return st;
}

/** The scenario's state when the talk track has reached beat `upTo` (facts said so far at their hand-off status). */
export function passPointState(id: string, upTo: number | "handoff"): CaseState {
  const s = kitScenario(id);
  const policy = policyOf(id);
  const truth = truthOf(id);
  const said = new Set<string>();
  for (const b of s.talk_track) if (upTo === "handoff" || b.n <= upTo) for (const f of b.facts ?? []) said.add(f);
  const spec: Partial<Record<FieldId, FieldSpec>> = {};
  for (const [f, fact] of Object.entries(s.facts) as [FieldId, KitFact][]) {
    spec[f] = upTo === "handoff" || said.has(f)
      ? { status: fact.status_at_handoff, value: truth[f] ?? null, source: fact.stated_by }
      : { status: "MISSING" };
  }
  return stateOf(policy, spec, `case_${id}_${upTo}`);
}

export interface NamedSnapshot { id: string; scenario: string; state: CaseState }

export function namedSnapshots(): NamedSnapshot[] {
  const out: NamedSnapshot[] = [];
  for (const id of ["s01", "s02", "s05"]) {
    const beats = kitScenario(id).talk_track.length;
    const p1 = Math.max(1, Math.round(beats / 3));
    const p2 = Math.max(p1 + 1, Math.round((2 * beats) / 3));
    out.push({ id: `${id}@beat${p1}`, scenario: id, state: passPointState(id, p1) });
    out.push({ id: `${id}@beat${p2}`, scenario: id, state: passPointState(id, p2) });
    out.push({ id: `${id}@handoff`, scenario: id, state: passPointState(id, "handoff") });
  }
  const s01 = policyOf("s01");
  const t = truthOf("s01");
  const all: Partial<Record<FieldId, FieldSpec>> = {};
  for (const f of REQUIRED_FIELDS) all[f] = { status: "VERIFIED", value: t[f] ?? null, source: f === "premium_new_monthly_usd" ? "rep" : "customer" };
  out.push({ id: "canned:all_verified", scenario: "s01", state: stateOf(s01, all, "case_canned_all") });
  out.push({ id: "canned:one_pending", scenario: "s01", state: stateOf(s01, { ...all, driver_full_name: { status: "PENDING", value: t.driver_full_name ?? null } }, "case_canned_pending") });
  out.push({ id: "canned:one_missing", scenario: "s01", state: stateOf(s01, { ...all, driver_full_name: { status: "MISSING" } }, "case_canned_missing") });
  out.push({ id: "canned:nothing", scenario: "s01", state: stateOf(s01, {}, "case_canned_nothing") });
  // WP1's canonical greeting states (tests/unit/core/compiler/greeting.test.ts).
  out.push({ id: "wp1:pending_name_verified_vehicle", scenario: "s01", state: stateOf(s01, {
    driver_full_name: { status: "PENDING", value: "maya" }, vehicle_assignment: { status: "VERIFIED", value: "veh2" },
  }, "case_wp1_a") });
  out.push({ id: "wp1:pending_incidents_cap", scenario: "s01", state: stateOf(s01, {
    driver_full_name: { status: "VERIFIED", value: "maya raman" }, vehicle_assignment: { status: "VERIFIED", value: "veh1" },
    effective_date: { status: "VERIFIED", value: "2026-10-02" }, incidents_3y: { status: "PENDING", value: "one speeding ticket in 2024" },
  }, "case_wp1_b") });
  out.push({ id: "wp1:all_vehicles_relation_display", scenario: "s01", state: stateOf(s01, {
    driver_full_name: { status: "VERIFIED", value: "maya raman" }, vehicle_assignment: { status: "VERIFIED", value: "all" },
    driver_relation: { status: "PENDING", value: "child" },
  }, "case_wp1_c") });
  out.push({ id: "wp1:roommate_pending", scenario: "s16", state: stateOf(policyOf("s16"), {
    driver_relation: { status: "PENDING", value: "non_relative_resident" }, operator_type: { status: "PENDING", value: "occasional" },
  }, "case_wp1_d") });
  return out;
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const OPTIONAL_SAMPLE: readonly FieldId[] = ["driver_age", "incidents_3y", "good_student_discount", "driver_training_discount",
  "coverage_change", "underwriting_review", "premium_change_monthly_usd", "amount_due_today_usd", "license_number"];

/** 200 seeded random snapshots (PLATFORM §4.6). */
export function randomSnapshots(n = 200, seed = 20260925): NamedSnapshot[] {
  const rnd = mulberry32(seed);
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
  const truths = SCENARIO_IDS.map((id) => ({ id, truth: truthOf(id) }));
  const out: NamedSnapshot[] = [];
  for (let i = 0; i < n; i++) {
    const scenario = pick(SCENARIO_IDS);
    const policy = policyOf(scenario);
    const spec: Partial<Record<FieldId, FieldSpec>> = {};
    for (const f of REQUIRED_FIELDS) {
      const status = pick(["VERIFIED", "PENDING", "MISSING"] as const);
      let value: string | null;
      if (f === "vehicle_assignment") value = pick([...policy.vehicles.map((v) => v.id), "all"]);
      else if (f === "effective_date") value = pick(truths).truth.effective_date ?? "2026-10-02";
      else value = pick(truths.filter((t) => t.truth[f] !== undefined)).truth[f] ?? null;
      const source: Party = f === "premium_new_monthly_usd" ? pick(["rep", "customer"] as const) : pick(["rep", "customer", "ai"] as const);
      spec[f] = { status, value, source };
    }
    for (const f of OPTIONAL_SAMPLE) {
      if (rnd() > 0.3) continue;
      const withF = truths.filter((t) => t.truth[f] !== undefined);
      const value = f === "license_number" ? pick(["A1234567", "RM88210", "d-4471-02"]).toUpperCase().replace(/[^A-Z0-9]/g, "") : withF.length ? pick(withF).truth[f]! : null;
      if (value === null) continue;
      spec[f] = { status: pick(["VERIFIED", "PENDING"] as const), value, source: pick(["rep", "customer"] as const) };
    }
    out.push({ id: `random:${i}`, scenario, state: stateOf(policy, spec, `case_random_${i}`) });
  }
  return out;
}

/** Every scenario fact's kit value and its `say_it` words (normalizeField inputs). */
export function normalizeInputs(): { scenario: string; field: FieldId; raw: string }[] {
  const out: { scenario: string; field: FieldId; raw: string }[] = [];
  for (const id of SCENARIO_IDS) {
    const s = kitScenario(id);
    for (const f of FIELD_IDS) {
      const fact = s.facts[f];
      if (!fact) continue;
      out.push({ scenario: id, field: f, raw: String(fact.value) });
      if (fact.say_it) out.push({ scenario: id, field: f, raw: fact.say_it });
    }
  }
  return out;
}

/** Compact, JSON-safe form of a snapshot's fields (the parity tests rebuild the CaseState from it). */
export type CompactFields = Record<string, [FieldStatus, string | null, Party | null, string | null]>;
export function compactFields(state: CaseState): CompactFields {
  const out: CompactFields = {};
  for (const f of FIELD_IDS) {
    const st = state.fields[f];
    if (!st || (st.status === "MISSING" && st.value === null)) continue;
    out[f] = [st.status, st.value, st.source, st.display];
  }
  return out;
}
