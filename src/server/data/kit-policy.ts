import "server-only";

import { PolicyRecordSchema, type PolicyRecord } from "../../core/contracts/case";

/**
 * Kit `Scenario` (data/scenarios/sNN.json, schema_version 1, read-only) → `PolicyRecord` (DESIGN §6.1: "rep + customer
 * → PolicyRecord"). WP9's `normalizeScenario` (src/core/scenario/normalize.ts) is the product mapping and its output
 * lands in src/generated/scenarios.json; this copy is the fallback the server uses until that file is registered
 * (G1), and it follows the same rules as WP1's test fixtures: `phoneOnFileLast4` = the last 4 digits of the policy
 * number, vehicle label = "<year> <make> <model>".
 */
interface KitScenarioLike {
  id?: unknown;
  call_date?: unknown;
  rep?: { name?: unknown; agency?: unknown };
  customer?: {
    name?: unknown; policy_number?: unknown; carrier?: unknown;
    address?: { street?: unknown; city?: unknown; state?: unknown; zip?: unknown };
    existing_drivers?: { name?: unknown; relation?: unknown }[];
    vehicles?: { id?: unknown; year?: unknown; make?: unknown; model?: unknown }[];
    current_premium_monthly_usd?: unknown;
  };
}

export function policyFromKitScenario(raw: unknown): PolicyRecord {
  const s = raw as KitScenarioLike;
  const c = s.customer ?? {};
  const [first = "", ...rest] = String(c.name ?? "").trim().split(/\s+/);
  const policyNumber = String(c.policy_number ?? "");
  const digits = policyNumber.replace(/\D/g, "");
  return PolicyRecordSchema.parse({
    policyNumber,
    carrier: String(c.carrier ?? ""),
    agencyName: String(s.rep?.agency ?? ""),
    repFirstName: String(s.rep?.name ?? "").trim().split(/\s+/)[0] ?? "",
    policyholder: { firstName: first, lastName: rest.join(" ") },
    phoneOnFileLast4: digits.slice(-4),
    address: {
      street: String(c.address?.street ?? ""),
      city: String(c.address?.city ?? ""),
      state: String(c.address?.state ?? ""),
      zip: String(c.address?.zip ?? ""),
    },
    existingDrivers: (c.existing_drivers ?? []).map((d) => ({ name: String(d.name ?? ""), relation: String(d.relation ?? "") })),
    vehicles: (c.vehicles ?? []).map((v) => ({
      id: String(v.id ?? ""),
      year: Number(v.year),
      make: String(v.make ?? ""),
      model: String(v.model ?? ""),
      label: `${Number(v.year)} ${String(v.make ?? "")} ${String(v.model ?? "")}`,
    })),
    currentMonthlyPremiumUsd: Number(c.current_premium_monthly_usd ?? 0),
    callDate: String(s.call_date ?? ""),
  });
}
