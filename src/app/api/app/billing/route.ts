import { getBillingState } from "@/server/billing/routes";

/** `GET /api/app/billing` — the Billing page's state (SAAS §4.4). $0: at most one sandbox read. */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = getBillingState;
