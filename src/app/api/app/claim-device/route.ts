import { declineClaimDevice, getClaimOffer, postClaimDevice } from "@/server/identity/app-claim";

/** The shared-device claim card (SAAS §2.6 R1, WP19·3): GET the offer, POST to claim, DELETE to decline. */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = getClaimOffer;
export const POST = postClaimDevice;
export const DELETE = declineClaimDevice;
