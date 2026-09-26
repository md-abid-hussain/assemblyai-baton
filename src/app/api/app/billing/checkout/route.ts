import { postCheckout } from "@/server/billing/routes";

/** `POST /api/app/billing/checkout {plan}` → `{url}` (SAAS §4.3). Polar **sandbox** only: no real money moves. */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = postCheckout;
