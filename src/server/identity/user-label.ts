import "server-only";

/**
 * The label an audit row freezes for a user actor (SAAS §9). WP19·3.
 *
 * §9 wants "a frozen email label", so the row still says who did it after the account is renamed, removed, or
 * deleted with the org. That means one small read per mutation — which is why it is memoized for a minute per
 * process: a burst of member changes from one admin is one query, and a label going a minute stale is a label
 * that was frozen a minute earlier, which is exactly what freezing means.
 *
 * A guest's generated address (`…@guest.changeover.invalid`) is not shown as an email: it is not one, and
 * printing it in the Audit page would look like a leak of something real.
 */
import { eq } from "drizzle-orm";

import { getDb } from "../db/client";
import { users } from "../db/schema-auth";
import { GUEST_EMAIL_DOMAIN } from "./auth";

const TTL_MS = 60_000;
const CACHE_MAX = 500;

type Entry = { label: string; at: number };
const g = globalThis as typeof globalThis & { __changeoverUserLabels?: Map<string, Entry> };
const cache: Map<string, Entry> = (g.__changeoverUserLabels ??= new Map());

/** The label for a user id, or `null` when there is no user (a system or visitor actor). */
export async function userLabel(userId: string | null | undefined): Promise<string | null> {
  if (!userId) return null;
  const hit = cache.get(userId);
  const now = Date.now();
  if (hit && now - hit.at < TTL_MS) return hit.label;

  let label = userId;
  try {
    const [row] = await getDb()
      .select({ email: users.email, name: users.name, isAnonymous: users.isAnonymous })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (row) {
      const isGuest = row.isAnonymous === true || row.email.endsWith(`@${GUEST_EMAIL_DOMAIN}`);
      label = isGuest ? "Guest" : row.email || row.name || userId;
    }
  } catch {
    // A label is a nicety; an audit row with the user id in it is still a true audit row.
  }
  if (cache.size > CACHE_MAX) cache.clear();
  cache.set(userId, { label, at: now });
  return label;
}

/** Tests only. */
export const resetUserLabels = (): void => void cache.clear();
