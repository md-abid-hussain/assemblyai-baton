import "server-only";

import { eq } from "drizzle-orm";

import type { PolicyRecord } from "../../core/contracts/case";
import { BatonError } from "../../core/contracts/errors";
import type { AccountRecord, CompiledRelay } from "../../core/contracts/v2";
import { policyToAccount } from "../../core/relay/account";
import { getDb, type Db } from "../db/client";
import { cases } from "../db/schema";
import { kitRatingSource, type RatingSource } from "../rating";

/**
 * Where `RelayToolService` gets the run it is executing in: the case row's relay version, the compiled relay for
 * that version, and the account it speaks to.
 *
 * It is a port with a small default rather than a direct import of WP14b's graph, because the same service runs on
 * three paths with three different resolvers (a test/live run from `/api/tools/[name]`, a published run from WP18's
 * gateway, and the WP16·3 console). The default mirrors `src/server/engine/takeover-compile.ts` exactly, so a tool
 * call and a takeover compile can never disagree about which blueprint or which account a case runs on.
 */

export interface RelayRunCase {
  id: string;
  policy: PolicyRecord;
  scenarioId: string;
  callId: string | null;
  /** How the case was opened; the route maps it to the `ConnectorCtx` mode ("live" stays live, the rest is "test"). */
  mode: string;
  /** null = a plain Baton case; `forVersion(null)` then compiles the flagship (only reached with RELAY_ENGINE=kernel). */
  relayVersionId: string | null;
  /** Set only when the case plays a simulated call: the account is the run version's sample at the sim's index. */
  simCallId: string | null;
}

export interface RelayRunSource {
  loadCase(caseId: string): Promise<RelayRunCase | null>;
  compiled(versionId: string | null): Promise<CompiledRelay>;
  account(compiled: CompiledRelay, c: RelayRunCase): Promise<AccountRecord>;
}

/** Read the case row's relay columns (a read-only select; WP14b owns the writes). */
export function dbRelayCaseLoader(db: () => Db = getDb): (caseId: string) => Promise<RelayRunCase | null> {
  return async (caseId) => {
    const [r] = await db()
      .select({
        id: cases.id, policy: cases.policy, scenarioId: cases.scenarioId, callId: cases.callId, mode: cases.mode,
        relayVersionId: cases.relayVersionId, simCallId: cases.simCallId,
      })
      .from(cases)
      .where(eq(cases.id, caseId))
      .limit(1);
    return r ? { ...r, policy: r.policy as unknown as PolicyRecord } : null;
  };
}

/**
 * The WP14b-backed default (the engine LRU, the kernel binding and the call catalog).
 *
 * One difference from `KernelBinding.policyToAccount`: a recorded Baton case's account is built WITH its scenario
 * rating, so `facts.rating_new_monthly_usd` / `facts.scenario_due_today_usd` exist and the relay's money values
 * (`monthly_premium`, `due_today`) resolve. Without them the flagship's `payment_link` would have no amount.
 * Request `wp16-to-wp14b.md` §4 asks for the same rating on the binding, so prompts and tools agree.
 */
export function defaultRelayRunSource(rating: RatingSource = kitRatingSource): RelayRunSource {
  const relays = async () => (await import("../relays")).getRelaysDeps();
  return {
    loadCase: dbRelayCaseLoader(),
    async compiled(versionId) {
      return (await relays()).engine.forVersion(versionId);
    },
    async account(compiled, c) {
      const d = await relays();
      const binding = d.binding();
      if (!binding) throw new BatonError("E_MAINTENANCE", "The relay engine is not available yet.");
      if (!c.simCallId) return policyToAccount(c.policy, await rating(c.scenarioId));
      if (!compiled.blueprint) throw new BatonError("E_INTERNAL", "This call cannot be run on the server.");
      const call = c.callId ? await d.catalog.resolve(c.callId) : null;
      const samples = compiled.blueprint.context.samples;
      return (call?.sampleIndex != null ? samples[call.sampleIndex] : undefined) ?? (samples[0] as AccountRecord);
    },
  };
}
