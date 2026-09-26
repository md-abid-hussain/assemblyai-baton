import { guestStart } from "@/server/identity/routes";

/** `POST /api/guest/start` — "Try it free · no signup" (SAAS §3.3, WP19). $0, no external call. */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = guestStart;
