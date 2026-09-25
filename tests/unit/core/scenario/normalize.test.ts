import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { resolveDueToday } from "../../../../src/core/compiler/disclosures";
import { ScenarioSchema } from "../../../../src/core/contracts/scenario";
import { FIELD_IDS } from "../../../../src/core/intents/add-driver.fields";
import { normalizeField } from "../../../../src/core/intents/add-driver";
import { ADD_DRIVER_SPEC, registerIntentSpec } from "../../../../src/core/scenario/intent-spec";
import type { KitSidecar } from "../../../../src/core/scenario/kit";
import { normalizeScenario, policyFromKit } from "../../../../src/core/scenario/normalize";
import { policyFromKitScenario } from "../../../../src/server/data/kit-policy";
import { loadScenarios, REPO_ROOT } from "../../../../scripts/calls/lib/kit-io";

const kits = loadScenarios(join(REPO_ROOT, "data", "scenarios"));
const review = (r: Partial<KitSidecar["review"]>): Pick<KitSidecar, "review"> => ({ review: { status: "keep", notes: [], fact_overrides: {}, status_overrides: {}, ...r } });

describe("normalizeScenario on the kit scenarios", () => {
  it("parses all 22 kit scenarios (shared.json is skipped)", () => {
    expect(kits.map((k) => k.id)).toEqual(Array.from({ length: 22 }, (_, i) => `s${String(i + 1).padStart(2, "0")}`));
  });

  it.each(kits.map((k) => [k.id, k] as const))("%s: valid Scenario; truth round-trips through WP1 normalizeField; statuses kept", (_id, kit) => {
    const drops: string[] = [];
    const s = normalizeScenario(kit, null, { onDrop: (f, v, why) => drops.push(`${f}=${String(v)} ${why}`) });
    expect(ScenarioSchema.safeParse(s).success).toBe(true);
    expect(drops).toEqual([]);
    for (const [f, v] of Object.entries(s.truth)) {
      const again = normalizeField(f as (typeof FIELD_IDS)[number], v, { policy: s.policy, callDate: s.callDate });
      expect(again?.norm, `${kit.id} ${f}`).toBe(v);
    }
    for (const [f, fact] of Object.entries(kit.facts)) expect(s.expectedAtHandoff[f as (typeof FIELD_IDS)[number]]).toBe(fact.status_at_handoff);
    expect(s.plannedHandoffS).toBe(kit.handoff.approx_at_s);
    expect(s.traps).toEqual(kit.eval.traps);
  });

  it.each(kits.map((k) => [k.id, k] as const))("%s: policy = WP3's kit mapping; dueToday = WP1 resolveDueToday", (_id, kit) => {
    const s = normalizeScenario(kit, null);
    expect(policyFromKit(kit)).toEqual(policyFromKitScenario(kit));
    const eff = s.truth.effective_date;
    const snapshot = { fields: { effective_date: { value: eff ?? null } } } as unknown as Parameters<typeof resolveDueToday>[0]["snapshot"];
    const due = s.truth.amount_due_today_usd !== undefined ? Number(s.truth.amount_due_today_usd) : null;
    const wp1 = resolveDueToday({ snapshot, newMonthlyUsd: String(s.rating.newMonthlyUsd), currentMonthlyUsd: s.policy.currentMonthlyPremiumUsd, scenarioDueTodayUsd: due, callDate: s.callDate });
    expect(s.rating.dueTodayUsd.toFixed(2)).toBe(wp1.dueTodayUsd);
  });

  it("sidecar overrides win over the design (value normalized, status replaced)", () => {
    const s01 = kits.find((k) => k.id === "s01")!;
    const s = normalizeScenario(s01, review({ fact_overrides: { effective_date: "2026-10-09", premium_new_monthly_usd: 139 }, status_overrides: { good_student_discount: "PENDING" } }));
    expect(s.truth.effective_date).toBe("2026-10-09");
    expect(s.truth.premium_new_monthly_usd).toBe("139.00");
    expect(s.rating.newMonthlyUsd).toBe(139);
    expect(s.expectedAtHandoff.good_student_discount).toBe("PENDING");
    expect(s.expectedAtHandoff.driver_dob).toBe("VERIFIED");
  });

  it("unknown fact keys are dropped with a reason, never a parse failure (field ids come from the intent spec)", () => {
    const s01 = kits.find((k) => k.id === "s01")!;
    const drops: string[] = [];
    const kit = { ...s01, facts: { ...s01.facts, pet_name: { value: "Rex", stated_by: "customer" as const, status_at_handoff: "VERIFIED" as const } } };
    const s = normalizeScenario(kit, review({ fact_overrides: { shoe_size: 9 } }), { onDrop: (f, _v, why) => drops.push(`${f}: ${why}`) });
    expect(drops).toEqual(["pet_name: not a field of intent add_driver", "shoe_size: override of an unknown field (intent add_driver)"]);
    expect(Object.keys(s.truth)).not.toContain("pet_name");
  });

  it("a scenario's intent selects its spec; unknown intents are refused", () => {
    const s01 = kits.find((k) => k.id === "s01")!;
    expect(() => normalizeScenario({ ...s01, intent: "renew_policy" }, null)).toThrow(/no intent spec/);
    const undo = registerIntentSpec({ ...ADD_DRIVER_SPEC, intent: "renew_policy" });
    try {
      expect(() => normalizeScenario({ ...s01, intent: "renew_policy" }, null)).toThrow(/only carries add_driver/);
    } finally {
      undo();
    }
  });
});
