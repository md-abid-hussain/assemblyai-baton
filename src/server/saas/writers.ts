import "server-only";

/**
 * One call that swaps the C3 in-memory ports for the real database writers (SAAS §4.5, §7.1, §9). WP19·3.
 *
 * `installWriters()` is idempotent and is called from `installIdentity()`, so **no call site anywhere changes**:
 * the audit hook, the outbox producers and the usage meters all keep talking to `getAuditWriter()`,
 * `getDomainEvents()` and `getUsageMeter()` exactly as they did at C3. This file is the only place that knows the
 * real implementations exist.
 *
 * It also registers the one count limit WP19 owns: `seats` = members + pending invitations (SAAS §4.1). WP14b
 * registers `relays`, WP16 `secrets` and `connectorHosts`, WP21/WP22/WP24 the rest; an unregistered counter reads
 * as 0, so each arrives independently.
 *
 * **Not registered here:** the purge steps. `registerPurgeStep` belongs to WP12's job runner, which mounts them
 * from its own start-up path (`docs/notes/requests/wp19-to-wp12.md`); calling it from an identity install would
 * put a job side effect on every request path.
 */
import type { PlanId } from "../../core/contracts/v3/identity";
import { createDbAuditWriter } from "../audit/writer";
import { createDbDomainEvents } from "../events/outbox";
import { countSeats, planOf } from "../identity/org-store";
import { log } from "../log";
import { setAuditWriter, setDomainEvents, setOrgCounter, setPlanResolver, setUsageMeter } from "./ports";
import { createDbUsageMeter } from "./usage-writer";

const writerLog = log.child({ component: "saas" });

/**
 * The plan of an org, read from `org_entitlements` (SAAS §4.4) instead of guessed from the id.
 *
 * The C3 default guesses — `ws_…` is a guest, everything else is Free — because at C3 there was no table to
 * read. There is now, written by `createOrg` since WP19·2, so entitlements should reflect it; WP21 keeps the
 * same row in sync with Polar and this resolver keeps working unchanged.
 *
 * **The legacy rule survives the change.** A `ws_<visitorId>` workspace has no `org_entitlements` row and must
 * stay on the guest plan, not fall through to Free — that is the difference between a device getting 3 live runs
 * a day and getting 5 (§4.1), and it is the v2 behaviour `TENANCY_MODE=legacy` promises to leave alone.
 */
export async function dbPlanResolver(orgId: string): Promise<PlanId> {
  if (orgId.startsWith("ws_")) return "guest";
  try {
    return await planOf(orgId);
  } catch (err) {
    // A plan lookup that fails must not fail the action: Free is the conservative answer for a real org.
    writerLog.warn("plan lookup failed; falling back to free", { err });
    return "free";
  }
}

let installed = false;

/** Idempotent: safe from every entry point, and from a test's `beforeEach` after `resetSaasPorts()`. */
export function installWriters(): void {
  if (installed) return;
  installed = true;
  setAuditWriter(createDbAuditWriter());
  setDomainEvents(createDbDomainEvents());
  setUsageMeter(createDbUsageMeter());
  setPlanResolver(dbPlanResolver);
  setOrgCounter("seats", (orgId) => countSeats(orgId));
  writerLog.debug("database writers registered");
}

/** Tests only: forget that `installWriters()` ran, so the next install re-registers over a reset registry. */
export function resetWritersInstall(): void {
  installed = false;
}
