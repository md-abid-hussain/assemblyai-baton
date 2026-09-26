import { postSimulatedConfirm } from "@/server/billing/routes";

/** `POST /api/app/billing/simulated {plan}` — the `BILLING_MODE=simulated` confirm button (SAAS §4.7). */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = postSimulatedConfirm;
