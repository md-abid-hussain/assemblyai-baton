import "server-only";

import type { CaseState, PolicyRecord } from "../../core/contracts/case";
import { BatonError } from "../../core/contracts/errors";
import type { CompiledTakeover } from "../../core/contracts/takeover";
import type { AccountRecord, CompiledRelay, CompileTakeoverOptions } from "../../core/contracts/v2";
import { log } from "../log";
import { ACCOUNT_KIND_MARKER } from "../../core/contracts/v2";
import { accountFromStored } from "../../core/relay/account";
import { runAccount, type RelayRunDeps } from "./run";

const isStoredAccount = (p: unknown): boolean =>
  typeof p === "object" && p !== null && (p as { $kind?: unknown }).$kind === ACCOUNT_KIND_MARKER;

const compileLog = log.child({ component: "relay-takeover-compile" });

/**
 * The WP5 compile port (TASKS-v2 §6 WP5, PLATFORM §4.7): a pass is compiled by the relay version the case runs, not
 * by Baton's compiler.
 *
 *   TakeoverService.compile → relayTakeoverCompile → RelayEngineFactory.forVersion(case.relayVersionId).takeover(...)
 *
 * It answers `null` — "not a relay compile", and the service keeps WP1's `compileTakeover` — in exactly ONE case:
 * the case has no `relay_version_id` (a plain Baton case under the default `RELAY_ENGINE=legacy`).
 *
 * Anything else — no kernel bound, an unknown version, a lint error, a compile failure — throws. **WP14b·3 made the
 * missing binding a throw rather than a fallback:** until this unit the only relay that could create a case was the
 * flagship, whose WP1 compile is the parity target, so falling back was correct. Now a Dental case exists, and a
 * Baton compile of one would hand the Voice Agent Baton's prompt and Baton's tools for a dental booking — a wrong
 * result where a 503 is the right one.
 *
 * The account is recovered exactly as `createRelayCase` chose it (`cases/create.ts`). A relay case stores it
 * (`$kind:"account"`), so it is read straight back — no guessing. A Baton case stores a `PolicyRecord`: a recorded
 * call maps it with the kernel's `policyToAccount`, a simulated one speaks to the RUN version's sample at the sim's
 * index. Workspace-scoped data is reached through the case row only, so nothing here reads a global.
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
    if (!binding) throw new BatonError("E_MAINTENANCE", "Relay runs are not available on this server yet. Baton still runs.");
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
  // A relay case persisted the account it runs on (WP14b·3); a Baton case persisted a PolicyRecord.
  if (isStoredAccount(c.policy)) return accountFromStored(c.policy);
  if (!c.simCallId) return policyToAccount(c.policy);
  if (!compiled.blueprint) {
    compileLog.error("no blueprint for a simulated relay case", { caseId: c.id, versionId: c.relayVersionId });
    throw new BatonError("E_INTERNAL", "This call cannot be compiled on the server.");
  }
  return runAccount({ blueprint: compiled.blueprint }, c.callId ? await d.catalog.resolve(c.callId) : null);
}
