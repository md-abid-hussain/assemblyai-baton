import "server-only";

/**
 * `POST /api/guest/start` — "Try it free · no signup" (SAAS §3.3). WP19.
 *
 * Budget: ≤ 400 ms p50, ≤ 1 s p95, **no external call and no paid call at all**.
 *
 * The landing CTA never awaits this: it primes the `AudioContext`, fires the fetch with `keepalive` and navigates
 * straight to `/call/<s01>?express=1`. So this endpoint is never on the click-to-pass path, and its failure modes
 * must all be quiet.
 *
 * **The 429 degrades, it does not block** (§3.3 step 2). These are anti-junk-row limits on a $0 endpoint, not spend
 * limits — the spend guard lives downstream on paid actions (§4.2). A whole judging panel behind one office or VPN
 * egress IP, re-running the flow, stays inside them. On the judged URL a rate-limit notice must never read like an
 * outage, so the body carries `degraded: true` and a fallback, and the UI keeps the user where they were.
 */
import { and, eq, isNull } from "drizzle-orm";

import { workspaceOf } from "../../core/contracts/v2/api";
import { getDb } from "../db/client";
import { relays } from "../db/schema";
import { sessions } from "../db/schema-auth";
import type { RateLimiter } from "../../core/contracts/services";
import { getRateLimiter } from "../limits";
import type { DbRateLimiter } from "../limits/rate-limiter";
import { log } from "../log";
import type { GuestSeeder } from "../../core/contracts/v3";
import { getGuestSeeder } from "../saas/ports";
import { requireVisitor } from "../auth/visitor";
import { pickActiveOrg } from "./active-org";
import { writeAudit } from "./audit-hook";
import { getAuth } from "./auth";
import { claimVisitorData } from "./claim";
import { guestLimits } from "./config";
import { GUEST_ORG_NAME } from "./link";
import { createOrg, guestSlug } from "./org-store";

const guestLog = log.child({ component: "identity" });

/** Rate buckets. Named here rather than in WP12's `RATE` table, which is not WP19's to edit. */
export const GUEST_BUCKETS = {
  device: "guest-dev",
  ipKeyHour: "guest-ipk-h",
  ipKeyDay: "guest-ipk-d",
  global: "guest-all",
} as const;
/** One key for the deployment-wide cap. */
const GLOBAL_KEY = "all";

/** What the UI does instead when the limits say no (§3.3 step 2). `/call/**` is unaffected either way. */
export const GUEST_FALLBACK: readonly string[] = Object.freeze(["/sign-up", "/call/<s01>?express=1"]);

export type GuestStartResult =
  // `orgId` is nullable on the reuse leg only: a session can legitimately have no org yet (the window between
  // sign-up and `/app`'s `ensurePersonalOrg`). Saying so is the honest answer — see step 1 in `startGuest`.
  | { status: 200; body: { orgId: string | null; reused: true } }
  | { status: 200; body: { orgId: string; relayIds: string[]; next?: string }; setCookie: string[] }
  | { status: 200; body: { orgId: string; degraded: true; reason: "accounts_unavailable" } }
  | { status: 429; body: { fallback: readonly string[]; degraded: true; reason: string } };

/** `?next=` accepts same-origin relative paths only (§3.9). Anything else is dropped, never echoed back. */
export function safeNext(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const v = raw.trim();
  if (!v.startsWith("/") || v.startsWith("//") || v.includes("\\")) return undefined;
  return v.length <= 512 ? v : undefined;
}

/** `Set-Cookie` values → a `cookie:` request header, so a server-side `auth.api` call can act as that session. */
function cookiePairs(setCookie: readonly string[]): string {
  return setCookie.map((c) => c.split(";")[0]).join("; ");
}

/**
 * One `Set-Cookie` per cookie name, keeping the **last**.
 *
 * A browser would collapse a duplicate name this way anyway, but emitting both is still wrong: `co.session_data`
 * appears twice, stale first, and anything that is not a browser — a fetch in a test, an SDK, a proxy that
 * re-serialises headers — is free to read the first one and see the pre-org session. Sending exactly one value per
 * name means the response says what we mean regardless of who parses it.
 */
function lastPerCookieName(values: readonly string[]): string[] {
  const byName = new Map<string, string>();
  for (const v of values) {
    const name = v.split("=")[0]?.trim().toLowerCase() ?? v;
    byName.set(name, v);
  }
  return [...byName.values()];
}

/**
 * Which limit was hit, or `null`. Read-only: nothing is consumed unless every limit has room.
 *
 * **Deliberately best-effort, not atomic.** The four buckets are checked first and only hit once all four have
 * room, so a burst of concurrent requests from one device can all pass the check before any of them records a
 * hit, and the caps can be overshot by roughly the concurrency. That is the right trade here and not a spend
 * hole: this endpoint costs **$0** and makes no external call (§3.3), so these are anti-junk-row limits; the
 * real spend guard is downstream on paid actions (§4.2), where `enforceRates` hits its buckets directly. The
 * alternative — hit-then-compare, four separate atomic increments — would consume from the earlier buckets on
 * every request the later ones reject, which turns a per-ipKey rejection into per-device budget the visitor
 * never spent. Tightening this means one atomic multi-bucket operation, not a reordering; until then the
 * numbers are ceilings under sequential use and approximate ceilings under a burst.
 */
async function checkLimits(visitorId: string, ipKey: string): Promise<string | null> {
  const l = guestLimits();
  const limiter = getRateLimiter() as RateLimiter & { check?: DbRateLimiter["check"] };
  const checks: [string, string, string, number, number][] = [
    ["device", GUEST_BUCKETS.device, visitorId, l.perDeviceDaily, 86_400],
    ["ipkey_hour", GUEST_BUCKETS.ipKeyHour, ipKey, l.perIpKeyHourly, 3_600],
    ["ipkey_day", GUEST_BUCKETS.ipKeyDay, ipKey, l.perIpKeyDaily, 86_400],
    ["global", GUEST_BUCKETS.global, GLOBAL_KEY, l.globalDaily, 86_400],
  ];
  // `check()` (read-only) is on `DbRateLimiter`, not on the `RateLimiter` contract, so it is an optional call in
  // exactly the way `enforceRates` treats it. Without it we skip straight to the hits: the limiter is then the
  // in-memory test one, where a partially-consumed bucket costs nothing.
  for (const [name, bucket, key, limit, windowSec] of checks) {
    const r = limiter.check ? await limiter.check(bucket, key, limit, windowSec) : { ok: true };
    if (!r.ok) return name;
  }
  // Every limit has room: consume one hit from each.
  for (const [, bucket, key, limit, windowSec] of checks) {
    await limiter.hit(bucket, key, limit, windowSec);
  }
  return null;
}

/** The flagship relay(s) to pin (§3.3 step 5). Baton is pinned, never cloned: it is the flagship on the legacy path. */
async function flagshipRelayIds(): Promise<string[]> {
  try {
    const rows = await getDb()
      .select({ id: relays.id })
      .from(relays)
      .where(and(eq(relays.flagship, true), isNull(relays.deletedAt)))
      .limit(4);
    return rows.map((r) => r.id);
  } catch (err) {
    // A guest workspace with nothing pinned is still a working workspace.
    guestLog.warn("could not read the flagship relay; the guest org starts unpinned", { err });
    return [];
  }
}

/**
 * The whole of §3.3, steps 1–7. Returns the status, the body and the Set-Cookie headers the route copies onto its
 * response — the route itself stays a thin adapter, and this function is directly testable.
 */
export async function startGuest(req: Request): Promise<GuestStartResult> {
  const visitor = requireVisitor(req);
  const auth = getAuth();

  // K-AUTH / no `BETTER_AUTH_SECRET`: the legacy device workspace still works, and `/app` renders read-only over it.
  // Nothing here says "unavailable": the demo behaves the same.
  if (!auth) {
    return {
      status: 200,
      body: { orgId: workspaceOf(visitor.visitorId), degraded: true, reason: "accounts_unavailable" },
    };
  }

  let next: string | undefined;
  try {
    const body = (await req.clone().json()) as unknown;
    if (body && typeof body === "object") next = safeNext((body as { next?: unknown }).next);
  } catch {
    /* no body, or not JSON: `next` is optional */
  }

  // 1. A session already exists → nothing to do. **Unconditionally** (§3.3 step 1), including when it has no
  //    active organization yet.
  //
  //    Falling through to step 3 in the no-active-org case would be a silent identity swap, not a repair. The
  //    anonymous plugin's own guard only refuses to re-anonymize a session that is *already* anonymous; it does
  //    not look at a real one. So `signInAnonymous` would succeed for a signed-in user, and the Set-Cookie it
  //    returns overwrites that browser's session cookie — the real session row survives in the database, but the
  //    browser is now holding a throwaway guest identity. That window is not hypothetical: every account sits in
  //    it between sign-up (`pickActiveOrg` → null, no membership yet) and `/app`'s `ensurePersonalOrg()`. And
  //    since this endpoint is unauthenticated and same-origin-exempt by design (§3.3: the landing CTA fires it
  //    with `keepalive` before any session exists), a cross-site POST could drive it.
  //
  //    A session with no active org is *reported*, never re-minted. `pickActiveOrg` covers the case where the
  //    user does have a membership and only the session row is older than it (it swallows its own errors and
  //    returns null). Otherwise `orgId` is null and `/app` creates the personal org, which is its job (§3.1).
  const existing = await auth.api.getSession({ headers: req.headers });
  if (existing?.session) {
    const active = existing.session.activeOrganizationId;
    const orgId = active ?? (existing.user?.id ? await pickActiveOrg(existing.user.id) : null);
    return { status: 200, body: { orgId, reused: true } };
  }

  // 2. Limits.
  const hit = await checkLimits(visitor.visitorId, visitor.ipKey);
  if (hit) {
    guestLog.info("guest start rate limited (degraded, not blocked)", { limit: hit });
    return { status: 429, body: { fallback: GUEST_FALLBACK, degraded: true, reason: hit } };
  }

  // 3. The anonymous session. `[VERIFY c]` PASS: `asResponse` carries the Set-Cookie headers.
  const res = await auth.api.signInAnonymous({ headers: req.headers, asResponse: true });
  const signInCookies = res.headers.getSetCookie();
  const signed = (await res.json().catch(() => null)) as { token?: string; user?: { id?: string } } | null;
  const userId = signed?.user?.id;
  const token = signed?.token;
  if (!userId) {
    // Better Auth has its own limiter inside this endpoint, so "no user" is usually its 429 rather than a fault.
    // Either way this is the one endpoint that must never look like an outage: degrade exactly as a §3.3 limit
    // does, so the UI shows the same calm fallback instead of an error.
    guestLog.warn("anonymous sign-in did not return a user; degrading", { status: res.status });
    return { status: 429, body: { fallback: GUEST_FALLBACK, degraded: true, reason: "signin_unavailable" } };
  }

  // 4. The organization, its owner membership, its metadata and its entitlements — in one transaction.
  //
  // G3: fill the gallery FIRST. `flagshipRelayIds()` reads the `relays` table, and on a cold deployment that
  // table is empty until something lists relays — which this endpoint never does. Without this the very first
  // visitor (the judge, or the landing CTA's background start) gets an unpinned workspace while everyone after
  // them gets Baton. Feature-tested rather than added to the `GuestSeeder` contract, the same way
  // `captureVersionSource` is in `src/server/relays/saas.ts`; the C3b no-op seeder simply does not have it.
  const seeder = getGuestSeeder() as GuestSeeder & Partial<{ ensureGallery(orgId?: string): Promise<void> }>;
  if (typeof seeder.ensureGallery === "function") {
    await seeder.ensureGallery().catch((err: unknown) => {
      guestLog.warn("could not seed the gallery before pinning; the guest org may start unpinned", { err });
    });
  }
  const pinned = await flagshipRelayIds();
  const org = await getDb().transaction(async (tx) => {
    const created = await createOrg(
      {
        name: GUEST_ORG_NAME,
        slug: guestSlug(),
        kind: "guest",
        createdVia: "guest_start",
        ownerUserId: userId,
        plan: "guest",
        pinnedRelayIds: pinned,
      },
      tx,
    );
    // The session was created before the membership existed, so `pickActiveOrg` could not fill this in.
    if (token) {
      await tx.update(sessions).set({ activeOrganizationId: created.id }).where(eq(sessions.token, token));
    }
    // 7 (first half). Written inside the transaction so an org can never exist without its creation row.
    await writeAudit(
      {
        orgId: created.id,
        actorType: "guest",
        actorId: userId,
        actorLabel: "Guest",
        action: "org.created",
        targetType: "org",
        targetId: created.id,
        metadata: { via: "guest_start" },
      },
      tx,
    );
    return created;
  });

  // 4b. Refresh the session cookie cache, or the browser spends five minutes believing it has no org.
  //
  // `session.cookieCache` (§3.9) mints a signed `co.session_data` cookie **at sign-in**, when the org did not exist
  // yet, so it carries `activeOrganizationId: null`. `getSession` prefers that cookie over the database for
  // `cookieCacheMaxAge`, so the row we just wrote in step 4 would be invisible to the very next request — on the
  // judged path, "Try it free" would land in an org-less `/app`. Asking the organization plugin to set the active
  // org re-issues the cache cookie with the right value; appending its Set-Cookie after the sign-in one means the
  // browser keeps the later value for the same cookie name.
  //
  // Best-effort: the database row is already correct and authoritative, so a failure here costs at most one stale
  // cache window, never the workspace.
  let setCookie = signInCookies;
  try {
    const activated = await auth.api.setActiveOrganization({
      headers: new Headers({ cookie: cookiePairs(signInCookies) }),
      body: { organizationId: org.id },
      asResponse: true,
    });
    const refreshed = activated.headers.getSetCookie();
    if (refreshed.length > 0) setCookie = lastPerCookieName([...signInCookies, ...refreshed]);
  } catch (err) {
    guestLog.warn("could not refresh the session cookie cache; the row is still correct", { err, orgId: org.id });
  }

  // 5. Seed. A WP14b port: it clones the Dental gallery relay (DB only — no compile, no moderation call).
  //    The default no-op seeder is fine until WP14b·4; the org is usable either way.
  let relayIds: string[] = [];
  try {
    relayIds = (await getGuestSeeder().seed(org.id)).relayIds;
  } catch (err) {
    guestLog.warn("guest seeding failed; the workspace is empty but usable", { err, orgId: org.id });
  }

  // 6. The device's own legacy data moves into the org it just created, in the same request (§2.6, automatic here
  //    and only here — see `claim.ts` for why a plain sign-in never does this).
  try {
    await claimVisitorData(visitor.visitorId, org.id, { via: "guest_start", actorId: userId, actorLabel: "Guest" });
  } catch (err) {
    guestLog.warn("guest claim failed; the data stays claimable", { err, orgId: org.id });
  }

  return {
    status: 200,
    body: { orgId: org.id, relayIds: [...pinned, ...relayIds], ...(next ? { next } : {}) },
    setCookie,
  };
}
