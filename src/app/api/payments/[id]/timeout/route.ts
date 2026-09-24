import { postTimeout } from "@/server/payments/routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/payments/[id]/timeout (WP6, additive): the hold handler's deadline passed (DESIGN §5.8 step 7). */
export const POST = postTimeout;
