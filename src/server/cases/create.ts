import "server-only";

import type { CallManifestEntry } from "../../core/contracts/scenario";
import type { CreateCaseResponse } from "../../core/contracts/api";
import { BatonError } from "../../core/contracts/errors";
import { workspaceOf, type AccountRecord, type CreateCaseRequestV2, type CreateCaseResponseV2 } from "../../core/contracts/v2";
import type { CaseDataSource } from "../data";
import { FLAGSHIP_SLUG, relayEngineMode } from "../engine/mode";
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
 * WP14b·3: **every** relay creates a case now. The gate that answered 503 for a non-flagship relay is gone, because
 * P§4.7 (WP14a·4) opened `CaseState.fields` and WP14a·3's spec injection made the core functions spec-driven. A
 * non-flagship case stores its `AccountRecord` in `cases.policy` and `intent:"relay"`, and reads resolve the engine
 * from `cases.relay_version_id` (`relay-engine.ts`). `policy` is null in that response (v2 `CreateCaseResponseV2`).
 */

/** Scenario for a case without a call (the golden demo scenario). */
export const DEFAULT_SCENARIO_ID = "s01";
const NO_ASSETS = { rep: "", customer: "", peaks: "" } as const;

const createLog = log.child({ component: "cases-create" });

/**
 * WP14b·4 (SAAS §7): who a case belongs to, when anyone is signed in. `POST /api/cases` stays a **device** route
 * — the `/call` demo path must keep working with no session at all — so both fields are optional and the v2
 * behaviour with neither of them is byte for byte what it was.
 */
export interface CaseTenant {
  orgId?: string | null;
  userId?: string | null;
}

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
  tenant: CaseTenant = {},
): Promise<CreateCaseResponse | CreateCaseResponseV2> {
  if (body.relayId || body.relayVersionId) return createRelayCase(d, body, visitor, tenant);
  const pinned = await kernelPinnedBaton(d, body, visitor, tenant);
  if (pinned) return pinned;
  const call = body.callId ? await d.data.getCall(body.callId) : body.mode === "watch" ? await d.data.featuredCall() : null;
  if (body.callId && !call) throw new BatonError("E_NOT_FOUND", "Unknown call.");
  const base = await createForCall(d, body, visitor, call, {}, tenant);
  const v2 = await batonV2Fields(d, base);
  return v2 ? { ...base, ...v2 } : base;
}

async function createForCall(
  d: CreateCaseDeps,
  body: CreateCaseRequestV2,
  visitor: CasesVisitor,
  call: CallManifestEntry | null,
  relay: { relayVersionId?: string; simCallId?: string | null; account?: AccountRecord },
  tenant: CaseTenant,
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
    ...(relay.account ? { account: relay.account } : {}),
    orgId: tenant.orgId ?? null,
    createdByUserId: tenant.userId ?? null,
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

/**
 * A relay run (`relayId` / `relayVersionId`): resolve, moderate, compile, then create the case (WP14b·3).
 *
 * The flagship keeps the v1 row exactly as it was — a `PolicyRecord` in `cases.policy`, a scenario, `intent` unchanged
 * — because Baton's takes, caches and parity corpus are pinned to it. **Any other relay** stores its `AccountRecord`
 * instead (`$kind:"account"`, P§4.2) and `intent:"relay"`, and every later read of that case picks the relay version's
 * engine out of `cases.relay_version_id`: its `IntentSpec` decides the fields and readiness, its dynamic extractor
 * decides the prompt and the `<intent>_patch` strict schema. Nothing about a Dental case flows through Baton's field
 * set any more, which is what the gate here used to prevent (it is gone; P§4.7 landed with WP14a·4).
 */
async function createRelayCase(d: CreateCaseDeps, body: CreateCaseRequestV2, visitor: CasesVisitor, tenant: CaseTenant = {}): Promise<CreateCaseResponseV2> {
  if (!d.relays) throw new BatonError("E_MAINTENANCE", "Relay runs are not available on this server yet. Baton still runs.");
  // The relay is resolved in the caller's OWN workspace: the org when there is one, the device workspace
  // otherwise. Passing the org here is what stops one tenant running another tenant's private relay.
  const p = await prepareRelayRun(d.relays(), {
    ws: tenant.orgId ?? workspaceOf(visitor.visitorId), relayId: body.relayId, relayVersionId: body.relayVersionId, callId: body.callId,
  });
  const call = p.call ? manifestEntryOf(p.call) : body.mode === "watch" ? await d.data.featuredCall() : null;
  const simulated = p.call?.simulated ?? false;
  const relay = { relayVersionId: p.run.versionId, simCallId: p.call?.simCallId ?? null };

  if (p.run.flagship) {
    const base = await createForCall(d, body, visitor, call, relay, tenant);
    const account = simulated ? runAccount(p.run, p.call) : p.binding.policyToAccount(base.policy);
    return { ...base, ...relayRunFields(p.compiled, account, simulated) };
  }

  // A non-flagship relay: the account IS the row. `p.call.account` is the sim's own sample when WP17 resolved one,
  // else the run version's sample at the sim's index (a preset that edits sample data runs on its own numbers).
  const account = p.call?.account ?? runAccount(p.run, p.call);
  const base = await createForCall(d, body, visitor, call, { ...relay, account }, tenant);
  return { ...base, policy: null, ...relayRunFields(p.compiled, account, simulated) };
}

/**
 * `RELAY_ENGINE=kernel` (P§4.6): a plain Baton run is pinned to the seeded flagship version, so the case records
 * `relay_version_id` and every later engine call passes `compiled.spec`. The row is otherwise a normal Baton row —
 * a `PolicyRecord` in `cases.policy`, `intent` unchanged — because the parity suite's whole claim is that the
 * blueprint reproduces the flagship, not that it replaces its data.
 *
 * Returns null under the default `legacy`, and also whenever the pin cannot be made (no relay graph, no kernel bound,
 * the gallery not seeded, a compile failure): the caller then runs the unchanged legacy path. The flagship never fails
 * because a P3 switch is misconfigured — the reason is logged instead.
 */
async function kernelPinnedBaton(d: CreateCaseDeps, body: CreateCaseRequestV2, visitor: CasesVisitor, tenant: CaseTenant): Promise<CreateCaseResponseV2 | null> {
  if (relayEngineMode() !== "kernel" || !d.relays) return null;
  try {
    return await createRelayCase(d, { ...body, relayId: FLAGSHIP_SLUG }, visitor, tenant);
  } catch (err) {
    createLog.warn("RELAY_ENGINE=kernel could not pin the flagship version; running legacy", { err });
    return null;
  }
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
