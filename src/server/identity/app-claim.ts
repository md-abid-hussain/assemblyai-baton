import "server-only";

/**
 * `/api/app/claim-device` — the shared-device claim card (SAAS §2.6 rule R1). WP19·3.
 *
 *   GET    /api/app/claim-device  → { offer, cases, relays, drafts }   — should `/app` show the card?
 *   POST   /api/app/claim-device  → { claimed: ClaimCounts }           — "Add to this workspace"
 *   DELETE /api/app/claim-device  → 204                                — "Not mine", permanent for this pair
 *
 * **The body never carries an id.** `visitorId` is re-derived from the signed `bvid` cookie by `requireVisitor`
 * inside `requirePrincipal`, so a forged or absent cookie fails before this code runs, and a valid cookie can
 * only ever claim its own device. That is the whole security property of R1: the HMAC binds the cookie to the
 * device, and nothing else in the request is trusted.
 *
 * `member:invite` would be the wrong permission and `relay:read` too weak: the claim writes relays and drafts
 * into the org, so it takes `relay:write` — member+ in the §3.7 matrix, exactly what §2.6 asks for.
 */
import { claimOffer, claimVisitorData, declineDeviceClaim } from "./claim";
import { actorOf } from "../audit/actor";
import { appPrincipal, appRoute, json, spendMutation } from "./app-http";
import { userLabel } from "./user-label";

/** GET — the offer. Read-only and cheap: `/app` calls it on every load for a signed-in user. */
export const getClaimOffer = appRoute("app.claim.offer", async (req: Request) => {
  const p = await appPrincipal(req, { perm: "relay:read" });
  return json(await claimOffer(p.orgId, p.visitorId));
});

/**
 * POST — do it. The audit row is `guest.claimed_device {via: "confirmed", …}` (§2.6 step 6), written inside
 * `claimVisitorData`'s own transaction, so the row and the move commit together.
 */
export const postClaimDevice = appRoute("app.claim.confirm", async (req: Request) => {
  const p = await appPrincipal(req, { perm: "relay:write", account: true });
  await spendMutation(p);
  const actor = actorOf(p, await userLabel(p.userId));
  const claimed = await claimVisitorData(p.visitorId, p.orgId, {
    via: "confirmed",
    actorId: actor.actorId,
    actorLabel: actor.actorLabel,
  });
  return json({ claimed });
});

/** DELETE — "Not mine". Idempotent and permanent for this `(org, device)` pair; nothing is moved or deleted. */
export const declineClaimDevice = appRoute("app.claim.decline", async (req: Request) => {
  const p = await appPrincipal(req, { perm: "relay:read" });
  await spendMutation(p);
  await declineDeviceClaim(p.orgId, p.visitorId);
  return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
});
