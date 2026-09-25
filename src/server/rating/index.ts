import "server-only";

import type { Scenario } from "../../core/contracts/scenario";

/**
 * The mock rating tool (DESIGN §5.8 `get_disclosure`): `mockRating(scenario) = scenario.rating.newMonthlyUsd`, the
 * kit's `premium_new_monthly_usd` truth standing in for a carrier rating engine (labelled "rating tool" in the UI).
 * `dueTodayUsd` is the kit's `amount_due_today_usd` when the scenario defines it; otherwise null and the handler
 * prorates (WP1 `resolveDueToday`).
 *
 * Source order: an injected `RatingSource` (the integrator wires WP9's normalized `src/generated/scenarios.json`
 * when it lands), else the table below, which is a copy of `data/scenarios/sNN.json` facts pinned by a unit test
 * (tests/unit/server/tools/rating.test.ts), so the deployed bundle needs no file reads.
 */

export interface RatingQuote {
  newMonthlyUsd: number;
  /** The scenario's own amount due today, or null (then it is prorated). */
  dueTodayUsd: number | null;
  source: "scenario";
}

export type RatingSource = (scenarioId: string) => Promise<RatingQuote | null>;

/** `mockRating(scenario)` for a normalized WP9 `Scenario`. */
export function mockRating(scenario: Pick<Scenario, "rating">): RatingQuote {
  return { newMonthlyUsd: scenario.rating.newMonthlyUsd, dueTodayUsd: scenario.rating.dueTodayUsd, source: "scenario" };
}

/** Kit facts (fictional prices): premium_new_monthly_usd and amount_due_today_usd per scenario. */
export const KIT_RATES: Readonly<Record<string, { newMonthlyUsd: number; dueTodayUsd: number | null }>> = {
  s01: { newMonthlyUsd: 142, dueTodayUsd: null },
  s02: { newMonthlyUsd: 171, dueTodayUsd: null },
  s03: { newMonthlyUsd: 188, dueTodayUsd: 18.4 },
  s04: { newMonthlyUsd: 149, dueTodayUsd: null },
  s05: { newMonthlyUsd: 204, dueTodayUsd: 34.1 },
  s06: { newMonthlyUsd: 219, dueTodayUsd: null },
  s07: { newMonthlyUsd: 121, dueTodayUsd: null },
  s08: { newMonthlyUsd: 171, dueTodayUsd: null },
  s09: { newMonthlyUsd: 134, dueTodayUsd: null },
  s10: { newMonthlyUsd: 187, dueTodayUsd: null },
  s11: { newMonthlyUsd: 176, dueTodayUsd: null },
  s12: { newMonthlyUsd: 183, dueTodayUsd: 21.7 },
  s13: { newMonthlyUsd: 246, dueTodayUsd: null },
  s14: { newMonthlyUsd: 158, dueTodayUsd: 27.85 },
  s15: { newMonthlyUsd: 167, dueTodayUsd: null },
  s16: { newMonthlyUsd: 121, dueTodayUsd: null },
  s17: { newMonthlyUsd: 238, dueTodayUsd: 29.6 },
  s18: { newMonthlyUsd: 149, dueTodayUsd: null },
  s19: { newMonthlyUsd: 212, dueTodayUsd: null },
  s20: { newMonthlyUsd: 205, dueTodayUsd: null },
  s21: { newMonthlyUsd: 193, dueTodayUsd: null },
  s22: { newMonthlyUsd: 186, dueTodayUsd: null },
};

/** The default source: the kit table. */
export const kitRatingSource: RatingSource = async (scenarioId) => {
  const r = KIT_RATES[scenarioId];
  return r ? { ...r, source: "scenario" } : null;
};

/** Build a source from normalized scenarios (WP9's `src/generated/scenarios.json`). */
export function scenarioRatingSource(scenarios: readonly Pick<Scenario, "id" | "rating">[]): RatingSource {
  const byId = new Map(scenarios.map((s) => [s.id, s]));
  return async (id) => {
    const s = byId.get(id);
    return s ? mockRating(s) : kitRatingSource(id);
  };
}
