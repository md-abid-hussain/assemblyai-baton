import "server-only";

import type { CaseState, PolicyRecord } from "../../core/contracts/case";
import { BatonError } from "../../core/contracts/errors";
import type { CompiledTakeover } from "../../core/contracts/takeover";
import type { AccountRecord, CompiledRelay, CompileTakeoverOptions } from "../../core/contracts/v2";
import { log } from "../log";
import { runAccount, type RelayRunDeps } from "./run";

const compileLog = log.child({ component: "relay-takeover-compile" });

/**
 * The WP5 compile port (TASKS-v2 §6 WP5, PLATFORM §4.7): a pass is compiled by the relay version the case runs, not
 * by Baton's compiler.
 *
 *   TakeoverService.compile → relayTakeoverCompile → RelayEngineFactory.forVersion(case.relayVersionId).takeover(...)
 *
 * It answers `null` — "not a relay compile", and the service keeps WP1's `compileTakeover` — in exactly two cases:
 *
 *   1. the case has no `relay_version_id` (a plain Baton case: every case created before this unit, and every case
 *      created by a `POST /api/cases` without `relayId`/`relayVersionId`);
 *   2. no kernel is bound (`kernel-binding.ts` is null until WP14a merges). A case CAN only carry a version id if a
 *      kernel was bound when it was created, and the only relay that creates a case today is the flagship (Baton),
 *      whose WP1 compile is the parity target. So falling back is correct, not a silent downgrade.
 *
 * Anything else — an unknown version, a lint error, a compile failure — throws, because a Baton compile of another
 * relay's case would hand the Voice Agent the wrong prompt rather than a degraded one.
 *
 * The account is recovered exactly as `createRelayCase` chose it (`cases/create.ts`): a simulated call speaks to the
 * RUN version's sample at the sim's index (so a preset that edits sample data keeps its own numbers), and a recorded
 * call speaks to the case's policy through the kernel's `policyToAccount`. Workspace-scoped data is reached through
 * the case row only, so nothing here reads a global (an org-scoped case later needs no change).
 */

/** The case fields the port reads; `TakeoverCase` (`takeovers/store.ts`) satisfies it. */
export interface RelayCompileCase {
  id: string;
  callId: string | null;
  policy: PolicyRecord;
  relayVersionId: string | null;
  simCallId: string | null;
}

export function relayTakeoverCompile(
  relays: () => RelayRunDeps,
): (i: { case: RelayCompileCase; snapshot: CaseState; opts: CompileTakeoverOptions }) => Promise<CompiledTakeover | null> {
  return async ({ case: c, snapshot, opts }) => {
    if (!c.relayVersionId) return null;
    const d = relays();
    const binding = d.binding();
    if (!binding) return null;
    const compiled = await d.engine.forVersion(c.relayVersionId);
    return compiled.takeover(snapshot, await accountForCase(d, compiled, c, binding.policyToAccount), opts);
  };
}

/** The account the case's run speaks to (`cases/create.ts`: a sim → the run version's sample, else the policy). */
async function accountForCase(
  d: RelayRunDeps,
  compiled: CompiledRelay,
  c: RelayCompileCase,
  policyToAccount: (p: PolicyRecord) => AccountRecord,
): Promise<AccountRecord> {
  if (!c.simCallId) return policyToAccount(c.policy);
  if (!compiled.blueprint) {
    compileLog.error("no blueprint for a simulated relay case", { caseId: c.id, versionId: c.relayVersionId });
    throw new BatonError("E_INTERNAL", "This call cannot be compiled on the server.");
  }
  return runAccount({ blueprint: compiled.blueprint }, c.callId ? await d.catalog.resolve(c.callId) : null);
}
