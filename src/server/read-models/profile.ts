import "server-only";

/**
 * Settings → Profile (SAAS §8.4, §3.10). WP20·2.
 *
 * Name, email (read-only), the linked providers, and the active sessions with a Revoke each.
 *
 * **What is deliberately absent: the IP address.** Better Auth stores one on every session row and every other
 * product in this category shows it. §10.5 keeps raw IPs out of what we render, and "Chrome on Windows · started
 * 24 Sep" is what a person actually uses to recognise the session they want gone. The column is read for nothing.
 *
 * **The current session is identified by id, not by the cookie.** The cookie value is a signed token and
 * comparing it to `sessions.token` by hand would mean re-implementing Better Auth's signature format for a
 * cosmetic label. `auth.api.getSession` already knows, so it is asked.
 */
import { desc, eq } from "drizzle-orm";

import { deviceLabel, type ProfileView, type SessionRowView } from "../../core/contracts/ext/wp20-app";
import type { Principal } from "../../core/contracts/v3/identity";
import { getDb, type Db } from "../db";
import { accounts, sessions, users } from "../db/schema-auth";
import { log } from "../log";

const iso = (d: Date | string | null | undefined): string => {
  if (d === null || d === undefined) return "";
  const dt = d instanceof Date ? d : new Date(d);
  return Number.isNaN(dt.getTime()) ? "" : dt.toISOString();
};

/** The id of the session this request is on, or `null`. Never throws: a missing label is not a failed page. */
export async function currentSessionId(headers: Headers): Promise<string | null> {
  try {
    const { getAuth } = await import("../identity");
    const auth = getAuth();
    if (!auth) return null;
    const s = await auth.api.getSession({ headers });
    return s?.session?.id ?? null;
  } catch (err) {
    log.warn("current_session_lookup_failed", { err: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

export async function loadProfile(
  p: Principal,
  opts: { currentSessionId?: string | null } = {},
  db: Db = getDb(),
): Promise<ProfileView> {
  const isGuest = p.kind === "visitor" || p.isAnonymous || p.userId === null;

  const base: ProfileView = {
    userId: p.userId,
    name: isGuest ? "Guest" : "You",
    email: null,
    createdAt: null,
    isGuest,
    providers: [],
    hasPassword: false,
    sessions: [],
  };
  if (!p.userId) return base;

  const [user] = await db
    .select({
      name: users.name,
      email: users.email,
      createdAt: users.createdAt,
      isAnonymous: users.isAnonymous,
    })
    .from(users)
    .where(eq(users.id, p.userId))
    .limit(1);

  const linked = await db
    .select({ providerId: accounts.providerId, password: accounts.password })
    .from(accounts)
    .where(eq(accounts.userId, p.userId));

  // Expired rows are still in the table until the cleanup runs; listing them would invite a pointless Revoke.
  const rows = await db
    .select({
      id: sessions.id,
      createdAt: sessions.createdAt,
      expiresAt: sessions.expiresAt,
      userAgent: sessions.userAgent,
    })
    .from(sessions)
    .where(eq(sessions.userId, p.userId))
    .orderBy(desc(sessions.createdAt))
    .limit(20);

  const now = Date.now();
  const live = rows.filter((r) => {
    const exp = r.expiresAt instanceof Date ? r.expiresAt.getTime() : new Date(r.expiresAt).getTime();
    return Number.isNaN(exp) || exp > now;
  });

  const sessionViews: SessionRowView[] = live.map((r) => ({
    id: r.id,
    createdAt: iso(r.createdAt),
    expiresAt: iso(r.expiresAt),
    device: deviceLabel(r.userAgent),
    current: opts.currentSessionId ? r.id === opts.currentSessionId : false,
  }));

  const anonymous = Boolean(user?.isAnonymous) || p.isAnonymous;

  return {
    userId: p.userId,
    name: anonymous ? "Guest" : user?.name || "You",
    email: anonymous ? null : user?.email ?? null,
    createdAt: user ? iso(user.createdAt) || null : null,
    isGuest: anonymous || isGuest,
    providers: [...new Set(linked.map((a) => a.providerId))].sort(),
    // "Has a password" is the credential account carrying one — that is what Change password can act on.
    hasPassword: linked.some((a) => a.providerId === "credential" && Boolean(a.password)),
    sessions: sessionViews,
  };
}
