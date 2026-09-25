import "server-only";

import type { CreateCaseRequest, CreateCaseResponse } from "../../core/contracts/api";
import { BatonError } from "../../core/contracts/errors";
import type { CaseDataSource } from "../data";
import type { CasesPlatform, CasesVisitor } from "./platform";
import type { PgCaseRepository } from "./repository";

/**
 * Route #3 `POST /api/cases` (DESIGN §4.4): create a case for a call (Watch) or a scenario (live, P2 cut), with an
 * optional Express prefill (cached turns and cached events up to `prefillUntilMs`, 0 LLM calls, §5.1.6), and hand
 * back the case token, the policy, the manifest entry, its asset URLs and the cached-turns URL.
 */

/** Scenario for a case without a call (the golden demo scenario). */
export const DEFAULT_SCENARIO_ID = "s01";
const NO_ASSETS = { rep: "", customer: "", peaks: "" } as const;

export async function createCase(
  d: { repo: PgCaseRepository; data: CaseDataSource; platform: CasesPlatform },
  body: CreateCaseRequest,
  visitor: CasesVisitor,
): Promise<CreateCaseResponse> {
  const call = body.callId ? await d.data.getCall(body.callId) : body.mode === "watch" ? await d.data.featuredCall() : null;
  if (body.callId && !call) throw new BatonError("E_NOT_FOUND", "Unknown call.");
  if (body.mode === "watch") {
    if (!call) throw new BatonError("E_NOT_FOUND", "There is no call to watch yet.");
    if (!call.assets) throw new BatonError("E_CASE_STATE", "This call's audio is not published.");
  }
  if (body.prefillUntilMs !== undefined && !call) throw new BatonError("E_BAD_REQUEST", "prefillUntilMs needs a call.");
  const created = await d.repo.create({
    mode: body.mode,
    callId: call?.callId ?? null,
    scenarioId: call?.scenarioId ?? DEFAULT_SCENARIO_ID,
    visitorId: visitor.visitorId,
    ipKey: visitor.ipKey,
    ...(body.prefillUntilMs !== undefined ? { prefillUntilMs: body.prefillUntilMs } : {}),
  });
  const caseToken = await d.platform.issueCaseToken({ caseId: created.caseId, visitorId: visitor.visitorId });
  return {
    caseId: created.caseId,
    caseToken,
    policy: created.policy,
    call,
    state: created.state,
    assets: call?.assets ?? { ...NO_ASSETS },
    cachedTurnsUrl: call ? await d.data.cachedTurnsUrl(call.callId) : null,
    visitorToken: d.platform.issueVisitorToken(visitor.visitorId),
  };
}
