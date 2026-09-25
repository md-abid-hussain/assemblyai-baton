import "server-only";

import { resolveRelativeDate } from "../../core/case";
import {
  compilePrompt, disclosureText, inputModeFor, nextStage, nextStepOf, resolveDueToday, resolvePremium, spokenDate, toolsForStage,
} from "../../core/compiler";
import { compatible, normalizeField } from "../../core/intents/add-driver";
import { requireCase } from "../auth";
import { getCaseRepository } from "../cases";
import { getFlagStore, getRateLimiter } from "../limits";
import type { PaymentsMode } from "../payments/service";
import type { ToolCore } from "./core-port";
import type { CaseSink, RequireTakeover } from "./wiring";

/**
 * The G1 bindings WP6 was waiting for (WP1, WP2 and WP3 are on main since `a914341`). `wp6()` uses these unless a
 * test or the integrator injects something else with `configureWp6({...})`.
 * - WP1: the pure tool helpers (docs/notes/requests/wp1-to-wp6.md).
 * - WP3: `getCaseRepository()` (`load`, `applyEvents`, `setCaseExtras`; wp3-to-wp6.md).
 * - WP2: `requireCase` (case JWT + visitor cookie match), the DB rate limiter, `payments_mode_override`.
 */
export const wp1ToolCore: ToolCore = {
  normalizeField: (field, raw, ctx) => normalizeField(field, raw, ctx),
  compatible,
  resolveRelativeDate,
  spokenDate,
  disclosureText: (kind, ctx, opts) => disclosureText(kind, ctx, opts),
  resolvePremium,
  resolveDueToday,
  toolsForStage: (stage, opts) => toolsForStage(stage, opts),
  compilePrompt: (state, policy, stage, opts) => compilePrompt(state, policy, stage, opts),
  nextStage,
  nextStepOf,
  inputModeFor,
};

export const wp3CaseSink = (): CaseSink => {
  const repo = getCaseRepository();
  return {
    load: (caseId) => repo.load(caseId),
    applyEvents: (caseId, v, events) => repo.applyEvents(caseId, v, events),
    setCaseExtras: (caseId, patch) => repo.setCaseExtras(caseId, patch),
  };
};

export const wp2RequireTakeover: RequireTakeover = async (req, want) => {
  const a = await requireCase(req, { takeoverId: want.takeoverId, scope: want.scope });
  return { caseId: a.caseId, visitorId: a.visitorId, takeoverId: a.takeoverId };
};

export const wp2RateLimiter = () => getRateLimiter();

export async function wp2PaymentsModeOverride(): Promise<PaymentsMode | null> {
  return (await getFlagStore().get()).paymentsModeOverride;
}
