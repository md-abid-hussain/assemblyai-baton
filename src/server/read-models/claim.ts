import "server-only";

/**
 * The shared-device claim card (SAAS §2.6 R1, a v3.1 addition assigned to WP20 by S§12). WP20·2.
 *
 * The rule this implements is a *removal* plus a card. The HMAC on `bvid` binds the cookie to a **device**, not
 * to a person, so claiming automatically on sign-in would move the previous person's unclaimed guest work into
 * the next person's workspace on a library PC, a demo laptop or a judge's borrowed browser. WP19 removed the
 * automatic call; this is the friendly half that replaces it.
 *
 * Three conditions, all of which must hold before the card exists at all:
 *
 * 1. **A real signed-in session.** Not a visitor (nothing to claim *into*) and not an anonymous guest — the
 *    guest start already claimed the device's data in the same request that created the org (§3.3 step 6), so
 *    offering it again would be offering a no-op.
 * 2. **Something claimable, and not already declined.** `claimOffer` (WP19·2) answers both in one call; "Not
 *    mine" writes `claim_declined_at` for the `(orgId, visitorId)` pair and the card never returns for it.
 * 3. **`relay:write`** — member and above. A viewer cannot add data to a workspace, so a viewer is not asked.
 *
 * It never throws. A failed count means no card, which is the direction that cannot move anybody's data.
 */
import type { ClaimCardView } from "../../core/contracts/ext/wp20-app";
import type { Principal } from "../../core/contracts/v3/identity";
import { can } from "../../core/contracts/v3/permissions";
import { log } from "../log";

const NO_OFFER: ClaimCardView = Object.freeze({ offer: false, orgName: "", cases: 0, relays: 0, drafts: 0 });

export async function loadClaimCard(p: Principal, orgName: string): Promise<ClaimCardView> {
  if (p.kind !== "session" || p.isAnonymous || !p.userId || !p.orgId) return NO_OFFER;
  if (!p.visitorId) return NO_OFFER;
  if (!can(p, "relay:write")) return NO_OFFER;

  try {
    const { claimOffer } = await import("../identity");
    const offer = await claimOffer(p.orgId, p.visitorId);
    if (!offer.offer) return NO_OFFER;
    return { offer: true, orgName, cases: offer.cases, relays: offer.relays, drafts: offer.drafts };
  } catch (err) {
    log.warn("claim_offer_failed", { err: err instanceof Error ? err.message : String(err) });
    return NO_OFFER;
  }
}
