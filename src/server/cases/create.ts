import "server-only";

import type { CallManifestEntry } from "../../core/contracts/scenario";
import type { CreateCaseResponse } from "../../core/contracts/api";
import { BatonError } from "../../core/contracts/errors";
import { workspaceOf, type CreateCaseRequestV2, type CreateCaseResponseV2 } from "../../core/contracts/v2";
import type { CaseDataSource } from "../data";
import { manifestEntryOf, prepareRelayRun, relayRunFields, runAccount, type RelayRunDeps } from "../engine/run";
import { log } from "../log";
import type { CasesPlatform, CasesVisitor } from "./platform";
import type { PgCaseRepository } from "./repository";

/**
 * Route #3 `POST /api/cases` (DESIGN §4.4): create a case for a call (Watch) or a scenario (live, P2 cut), with an
 * optional Express prefill (cached turns and cached events up to `prefillUntilMs`, 0 LLM calls, §5.1.6), and hand
 * back the case token, the policy, the manifest entry, its asset URLs and the cached-turns URL.
 *
 * v2 (TASKS-v2 §5, WP14b·2): the request may name a relay (`relayId`, whose draft the server snapshots for its owner)
 * or a version (`relayVersionId`, e.g. a gallery preset). Then the version is resolved in the visitor's workspace,
 * moderated before its first run, compiled through the `RelayEngineFactory`, and the response gains `account`,
 * `relay` (UiSpec), `listening`, `simulated` and `provenance`; the case row records `relay_version_id` and
 * `sim_call_id`. A Baton request without either keeps its v1 behaviour and gains the v2 fields only when the kernel is
 * bound (best effort: a failure there never fails a Baton run).
 *
 * Only the flagship relay (Baton) creates a case today: the case engine is Baton's until the contract widening and
 * spec injection land (P§4.7, WP14a·3), so another relay answers 503 E_MAINTENANCE after its access, moderation and
 * compile checks (WP14b·3 lifts this).
 */

/** Scenario for a case without a call (the golden demo scenario). */
export const DEFAULT_SCENARIO_ID = "s01";
const NO_ASSETS = { rep: "", customer: "", peaks: "" } as const;

const createLog = log.child({ component: "cases-create" });

export interface CreateCaseDeps {
  repo: PgCaseRepository;
  data: CaseDataSource;
  platform: CasesPlatform;
  /** The relay graph (`getRelaysDeps()`), read lazily: only relay runs and a bound kernel touch it. */
  relays?: () => RelayRunDeps;
}

export async function createCase(
  d: CreateCaseDeps,
  body: CreateCaseRequestV2,
  visitor: CasesVisitor,
): Promise<CreateCaseResponse | CreateCaseResponseV2> {
  if (body.relayId || body.relayVersionId) return createRelayCase(d, body, visitor);
  const call = body.callId ? await d.data.getCall(body.callId) : body.mode === "watch" ? await d.data.featuredCall() : null;
  if (body.callId && !call) throw new BatonError("E_NOT_FOUND", "Unknown call.");
  const base = await createForCall(d, body, visitor, call, {});
  const v2 = await batonV2Fields(d, base);
  return v2 ? { ...base, ...v2 } : base;
}

async function createForCall(
  d: CreateCaseDeps,
  body: CreateCaseRequestV2,
  visitor: CasesVisitor,
  call: CallManifestEntry | null,
  relay: { relayVersionId?: string; simCallId?: string | null },
): Promise<CreateCaseResponse> {
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
    ...(relay.relayVersionId ? { relayVersionId: relay.relayVersionId } : {}),
    ...(relay.simCallId ? { simCallId: relay.simCallId } : {}),
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

/** A relay run (`relayId` / `relayVersionId`): resolve, moderate, compile, then create the case. */
async function createRelayCase(d: CreateCaseDeps, body: CreateCaseRequestV2, visitor: CasesVisitor): Promise<CreateCaseResponseV2> {
  if (!d.relays) throw new BatonError("E_MAINTENANCE", "Relay runs are not available on this server yet. Baton still runs.");
  const p = await prepareRelayRun(d.relays(), {
    ws: workspaceOf(visitor.visitorId), relayId: body.relayId, relayVersionId: body.relayVersionId, callId: body.callId,
  });
  if (!p.run.flagship) {
    throw new BatonError("E_MAINTENANCE", "This relay compiles, but relay runs other than Baton open with the next engine update. Try the Baton relay meanwhile.");
  }
  const call = p.call ? manifestEntryOf(p.call) : body.mode === "watch" ? await d.data.featuredCall() : null;
  const base = await createForCall(d, body, visitor, call, { relayVersionId: p.run.versionId, simCallId: p.call?.simCallId ?? null });
  const simulated = p.call?.simulated ?? false;
  const account = simulated ? runAccount(p.run, p.call) : p.binding.policyToAccount(base.policy);
  return { ...base, ...relayRunFields(p.compiled, account, simulated) };
}

/** The v2 fields for a plain Baton run: the flagship compiled with `forVersion(null)`, when the kernel is bound. */
async function batonV2Fields(d: CreateCaseDeps, base: CreateCaseResponse): Promise<ReturnType<typeof relayRunFields> | null> {
  if (!d.relays) return null;
  try {
    const r = d.relays();
    const b = r.binding();
    if (!b) return null;
    const compiled = await r.engine.forVersion(null);
    return relayRunFields(compiled, b.policyToAccount(base.policy), false);
  } catch (err) {
    createLog.warn("baton v2 response fields unavailable", { caseId: base.caseId, err });
    return null;
  }
}
