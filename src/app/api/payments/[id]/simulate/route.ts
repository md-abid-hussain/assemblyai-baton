import { postSimulate } from "@/server/payments/routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** #17 POST /api/payments/[id]/simulate (DESIGN §4.4): any provider, any PAYMENTS_MODE. */
export const POST = postSimulate;
