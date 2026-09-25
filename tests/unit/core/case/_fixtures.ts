/**
 * Shared WP1 test fixtures: policies and hand-off states built from the kit scenarios (data/scenarios/*.json,
 * read-only), plus small state builders. Not a test file (no `.test.ts`).
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  CaseState, FieldId, FieldState, FieldStatus, Party, PolicyRecord, StatusReason,
} from "../../../../src/core/contracts";
import { emptyCaseState, readinessOf } from "../../../../src/core/case/state";
import { normalizeField } from "../../../../src/core/intents/add-driver";

const ROOT = resolve(fileURLToPath(new URL("../../../..", import.meta.url)));

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
}

export function kitScenario(id: string): KitScenario {
  return JSON.parse(readFileSync(join(ROOT, "data", "scenarios", `${id}.json`), "utf8")) as KitScenario;
}

/** The PolicyRecord WP9's normalizeScenario will produce (phoneOnFileLast4 = last 4 policy-number digits). */
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

/** Normalized kit truth (all facts, regardless of status). */
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

export function expectedAtHandoff(id: string): Partial<Record<FieldId, FieldStatus>> {
  const s = kitScenario(id);
  return Object.fromEntries(Object.entries(s.facts).map(([f, fact]) => [f, fact!.status_at_handoff])) as Partial<Record<FieldId, FieldStatus>>;
}

export interface FieldSpec { status: FieldStatus; value?: string | null; source?: Party | null; reason?: StatusReason; display?: string | null }

/** Build a CaseState from per-field specs (values are NORMALIZED; display computed by normalizeField). */
export function stateOf(policy: PolicyRecord, spec: Partial<Record<FieldId, FieldSpec>>, caseId = "case_test"): CaseState {
  const st = emptyCaseState(caseId);
  for (const [f, s] of Object.entries(spec) as [FieldId, FieldSpec][]) {
    const value = s.status === "MISSING" ? null : (s.value ?? null);
    const display = s.display !== undefined ? s.display : value !== null ? (normalizeField(f, value, { policy, callDate: policy.callDate })?.display ?? value) : null;
    const fs: FieldState = {
      field: f,
      status: s.status,
      reason: s.reason ?? (s.status === "VERIFIED" ? "acknowledged" : s.status === "PENDING" ? "stated_once" : "absent"),
      value,
      display,
      source: s.status === "MISSING" ? null : (s.source ?? "customer"),
      evidence: [],
      conflict: null,
      flags: [],
      updatedAtMs: 0,
    };
    st.fields[f] = fs;
  }
  st.readiness = readinessOf(st.fields);
  return st;
}

/** The kit designer's intended hand-off state of a scenario (values normalized from the kit truth). */
export function handoffStateOf(id: string): CaseState {
  const s = kitScenario(id);
  const policy = policyOf(id);
  const truth = truthOf(id);
  const spec: Partial<Record<FieldId, FieldSpec>> = {};
  for (const [f, fact] of Object.entries(s.facts) as [FieldId, KitFact][]) {
    spec[f] = { status: fact.status_at_handoff, value: truth[f] ?? null, source: fact.stated_by };
  }
  return stateOf(policy, spec, `case_${id}`);
}
