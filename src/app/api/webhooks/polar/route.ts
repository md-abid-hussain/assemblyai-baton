import { postPolarWebhook } from "@/server/payments/routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** #18 POST /api/webhooks/polar (DESIGN §4.4, §5.12): verified, idempotent on webhook-id, 202. */
export const POST = postPolarWebhook;
