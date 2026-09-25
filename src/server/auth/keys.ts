import "server-only";

import { BatonError } from "../../core/contracts/errors";
import { env } from "../env";
import { bearerOf } from "./case-token";
import { safeEqual } from "./crypto";

/**
 * Shared-secret route guards (DESIGN §4.3), all constant-time. A missing configured secret never authorizes.
 *  - admin:  `x-admin-key` = ADMIN_KEY
 *  - cron:   `x-cron-secret` = CRON_SECRET, or `Authorization: Bearer <CRON_SECRET>` (Vercel Cron style)
 *  - limits: `x-limits-key` = LIMITS_AUTHORITY_KEY, only when LIMITS_ROLE=authority (404 elsewhere, so a remote
 *            deployment never exposes a second authority)
 */

function matches(given: string | null | undefined, expected: string | undefined): boolean {
  if (!given || !expected) return false;
  return safeEqual(given.trim(), expected);
}

export function requireAdmin(req: { headers: Headers }): void {
  if (!matches(req.headers.get("x-admin-key"), env().ADMIN_KEY)) throw new BatonError("E_FORBIDDEN", "Admin key required.");
}

export function requireCron(req: { headers: Headers }): void {
  const expected = env().CRON_SECRET;
  if (matches(req.headers.get("x-cron-secret"), expected) || matches(bearerOf(req), expected)) return;
  throw new BatonError("E_FORBIDDEN", "Cron secret required.");
}

export function requireLimitsKey(req: { headers: Headers }): void {
  const e = env();
  if (e.LIMITS_ROLE !== "authority") throw new BatonError("E_NOT_FOUND", "Not the limits authority.");
  if (!matches(req.headers.get("x-limits-key"), e.LIMITS_AUTHORITY_KEY)) throw new BatonError("E_FORBIDDEN", "Limits key required.");
}
