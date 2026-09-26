import "server-only";

/**
 * WP14b·4 — the relay layer's SaaS adoption: the plan check on create, the audit rows of SAAS §9, and the ports
 * WP19 left for this unit to fill (`RelaySourceStore`, `GuestSeeder`, the `relays` count).
 *
 * Everything here is **additive and inert under `TENANCY_MODE=legacy`**: the plan check reads the guest plan's
 * relay limit, which is the v2 per-visitor quota the routes already enforce, and an audit write that fails is
 * logged rather than thrown (`writeAudit`). That is deliberate — the v2 route tests must pass unchanged, and a
 * demo must never lose a save because an audit row could not be written.
 */
import { and, eq, isNull, ne, sql } from "drizzle-orm";

import type { Principal } from "../../core/contracts/v3/identity";
import { AUDIT_SOURCE_SAVED_COALESCE_MS, type AuditAction } from "../../core/contracts/v3/audit";
import { relays } from "../db/schema";
import { getDb, type Db } from "../db/client";
import { writeAudit } from "../identity/audit-hook";
import { log } from "../log";
import { getEntitlements, getRelaySourceStore, setGuestSeeder, setOrgCounter, setRelaySourceStore } from "../saas/ports";

const saasLog = log.child({ component: "relays-saas" });

// ------------------------------------------------------------------------------------------------ the relay count

/**
 * Live relays of an org: the same predicate as `PgRelayRegistry.countLive`, which is the quota the routes show.
 *
 * `db` is the relay graph's own handle, not `getDb()`. A counter that opened its own connection would ignore
 * `setRelaysDeps({db})` — it would read the wrong database in tests and every injected-graph caller, while
 * looking correct in production. The port takes the graph's db for the same reason the registry does.
 */
export async function countRelaysForOrg(orgId: string, db: Db = getDb()): Promise<number> {
  const [r] = await db
    .select({ n: sql<number>`count(*)::int`.mapWith(Number) })
    .from(relays)
    .where(
      and(
        eq(relays.workspaceId, orgId),
        isNull(relays.deletedAt),
        ne(relays.status, "archived"),
        ne(relays.visibility, "gallery"),
      ),
    );
  return r?.n ?? 0;
}

/**
 * The plan's relay limit on create / clone / import (SAAS §4.2). It throws `E_PLAN_LIMIT` (402), which the Studio
 * renders as the upgrade card rather than as an error.
 *
 * A **gallery clone stays exempt**, exactly as in v2: cloning Baton or Dental is step 1 of the judge path and of
 * every first session, and a plan wall there would be the worst possible first impression. The exemption is
 * decided by the caller (`enforceCreateQuota` already computes it) and passed in.
 */
export async function assertRelayBudget(orgId: string, exempt: boolean): Promise<void> {
  if (exempt) return;
  await getEntitlements().assertCount(orgId, "relays");
}

// --------------------------------------------------------------------------------------------------- audit rows

/**
 * `relay.source_saved` is coalesced to one row per 10 minutes per user and relay, and written at most once per rev
 * (SAAS §9, `AUDIT_SOURCE_SAVED_COALESCE_MS`). Without this an autosave every 2 s of idle would bury every other
 * audit row under a relay's editing history, which is the opposite of what an audit log is for.
 *
 * In-process state: the coalescing is a log-volume concern, not a correctness one, so a second container writing
 * one extra row is fine and a shared table would not be worth its cost here.
 */
const lastSourceAudit = new Map<string, { at: number; rev: number }>();

export function shouldAuditSourceSave(key: string, rev: number, now: number): boolean {
  const prev = lastSourceAudit.get(key);
  if (prev && prev.rev === rev) return false;
  if (prev && now - prev.at < AUDIT_SOURCE_SAVED_COALESCE_MS) return false;
  lastSourceAudit.set(key, { at: now, rev });
  return true;
}

/** Tests: forget the coalescing window. */
export function resetSourceAuditWindow(): void {
  lastSourceAudit.clear();
}

export async function auditSourceSaved(
  p: Principal,
  relayId: string,
  rev: number,
  hash: string,
  via: "studio" | "api" | "cli",
  now: number = Date.now(),
): Promise<void> {
  const actorKey = p.userId ?? p.apiKeyId ?? p.visitorId;
  if (!shouldAuditSourceSave(`${actorKey}:${relayId}`, rev, now)) return;
  await auditRelay(p, "relay.source_saved", relayId, { rev, via, hash });
}

/** One audit row about a relay, with the actor taken from the principal and never from a body field. */
export async function auditRelay(
  p: Principal,
  action: AuditAction,
  relayId: string,
  metadata?: Record<string, unknown>,
): Promise<void> {
  await writeAudit({
    orgId: p.orgId,
    // A device visitor and an anonymous account are both "guest" in the audit vocabulary: the log answers
    // "who did this" for a human reading it, and both of those are the same kind of who.
    actorType: p.kind === "api_key" ? "api_key" : p.kind === "session" && !p.isAnonymous ? "user" : "guest",
    actorId: p.userId ?? p.apiKeyId ?? p.visitorId,
    actorLabel: actorLabelOf(p),
    action,
    targetType: "relay",
    targetId: relayId,
    ...(metadata ? { metadata } : {}),
  });
}

function actorLabelOf(p: Principal): string {
  if (p.kind === "api_key") return `API key ${p.apiKeyId ?? "unknown"}`;
  if (p.kind === "session") return p.isAnonymous ? "Guest" : (p.userId ?? "Member");
  return "Visitor";
}

/**
 * Ask the registered source store to keep a version's text, when it is a store that can (WP14b's can; the default
 * empty one cannot). A feature test rather than a cast: the port's contract in `contracts/v3` has three methods,
 * and `captureVersionSource` is WP14b's own addition on top of it, so a deployment running a different store
 * simply snapshots without a stored source and reads fall back to serializing the blueprint.
 */
export async function captureVersionSource(relayId: string, versionId: string, created: boolean): Promise<void> {
  const store = getRelaySourceStore() as Partial<{ captureVersionSource(r: string, v: string, c: boolean): Promise<void> }>;
  if (typeof store.captureVersionSource !== "function") return;
  try {
    await store.captureVersionSource(relayId, versionId, created);
  } catch (err) {
    saasLog.warn("version source not captured; the version still reads from its blueprint", { versionId, err });
  }
}

// ------------------------------------------------------------------------------------------- port registration

/**
 * Register WP14b's implementations of the ports WP19 declared. Called every time the relay graph is built, and
 * **not** guarded by an "already installed" flag: building the graph is what defines the world in this codebase
 * (`setRelaysDeps`), so a rebuild with a different db must re-point the ports at it. Skipping the second call
 * would leave the store and the counter reading the previous graph's database.
 */
export function installRelaySaas(deps: {
  db: Db;
  sourceStore: import("../../core/contracts/v3").RelaySourceStore;
  seeder: import("../../core/contracts/v3").GuestSeeder;
}): void {
  setRelaySourceStore(deps.sourceStore);
  setGuestSeeder(deps.seeder);
  setOrgCounter("relays", (orgId) => countRelaysForOrg(orgId, deps.db));
  saasLog.info("relay saas ports registered");
}

/** Tests: clear the audit coalescing window (the ports themselves are reset by `resetSaasPorts`). */
export function resetRelaySaasInstall(): void {
  resetSourceAuditWindow();
}
