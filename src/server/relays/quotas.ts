import "server-only";

import { BatonError } from "../../core/contracts/errors";
import { RELAY_QUOTAS } from "../../core/contracts/ext/wp14b-relays";
import type { CreateRelayRequest } from "../../core/contracts/v2";
import { enforceRates, type RateSpec } from "../limits/rate-limiter";
import { getEntitlements } from "../saas/ports";
import { tenancyMode } from "../saas/principal";
import type { RelaysDeps, RelaysVisitor } from "./index";

/**
 * The relay quota buckets (PLATFORM §10.2; names from `QUOTA_BUCKETS`). Per-visitor and per-ipKey buckets are
 * conveniences; the global cap never refuses a create (the registry archives an idle relay instead).
 *
 * - `relay:create` (blank, blueprint, clone of an own relay): 5 live relays and 10/day per visitor, 20/day per ipKey →
 *   429 "You have 5 relays; delete one to add another." **Clone-from-gallery is exempt** (it is the $0 path every
 *   judge takes), and so is a clone of an unlisted relay shared with this visitor.
 * - `relay:save` (draft saves, visibility, "Save version"): 120/h per visitor → 429 with a retry note.
 * Nothing here is ever consulted by reads, lint, compile or delete, and exhausting a paid bucket (`run`, `sim:*`,
 * `draft`, ...) never touches these routes.
 */
export const RELAY_RATES = {
  createVisitor: { bucket: "relay:create", limit: RELAY_QUOTAS.createPerVisitorPerDay, windowSec: 86_400 },
  createIp: { bucket: "relay:create:ip", limit: RELAY_QUOTAS.createPerIpPerDay, windowSec: 86_400 },
  saveVisitor: { bucket: "relay:save", limit: RELAY_QUOTAS.savePerVisitorPerHour, windowSec: 3600 },
} as const satisfies Record<string, RateSpec>;

export async function enforceCreateQuota(d: RelaysDeps, visitor: RelaysVisitor, ws: string, from: CreateRelayRequest): Promise<void> {
  if (from.kind === "clone") {
    const src = await d.registry.cloneSource(from.relayId, ws);
    // a clone of something this visitor can only read (a gallery relay or preset, someone's unlisted relay) is exempt
    if (src && d.registry.accessOf(src.row, ws) === "reader") return;
  }
  await enforceRelayCount(d, ws);
  await enforceRates(d.rateLimiter(), [
    { spec: RELAY_RATES.createVisitor, key: visitor.visitorId, message: "You have created 10 relays today. Try again tomorrow, or clone from the gallery." },
    { spec: RELAY_RATES.createIp, key: visitor.ipKey, message: "Too many relays created from this network today. Clone from the gallery instead." },
  ]);
}

/**
 * How many relays a workspace may hold (WP14b·4).
 *
 * **Which limit applies is decided by the tenancy mode, not by both at once.** Under `TENANCY_MODE=legacy` there
 * are no orgs and no plans in force, so it is the v2 cap (`RELAY_QUOTAS.liveRelaysPerVisitor` = 5) with the v2
 * `E_RATE_LIMITED` message, byte for byte — that is what keeps the v2 route tests passing unchanged. Under `orgs`
 * it is the plan's `relays` limit (SAAS §4.2), which answers 402 `E_PLAN_LIMIT` with the upgrade payload the
 * Studio renders as a card.
 *
 * Running both would mean the guest plan's 3 silently overrode the v2 5 the moment this unit landed, which is a
 * behaviour change smuggled in under a refactor.
 */
export async function enforceRelayCount(d: RelaysDeps, ws: string): Promise<void> {
  if (tenancyMode() === "orgs") {
    await getEntitlements().assertCount(ws, "relays");
    return;
  }
  if ((await d.registry.countLive(ws)) >= RELAY_QUOTAS.liveRelaysPerVisitor) {
    throw new BatonError("E_RATE_LIMITED", `You have ${RELAY_QUOTAS.liveRelaysPerVisitor} relays; delete one to add another.`);
  }
}

export async function enforceSaveQuota(d: RelaysDeps, visitor: RelaysVisitor): Promise<void> {
  await enforceRates(d.rateLimiter(), [
    { spec: RELAY_RATES.saveVisitor, key: visitor.visitorId, message: "Too many saves in the last hour. Your edits are kept in this tab; try again in a few minutes." },
  ]);
}
