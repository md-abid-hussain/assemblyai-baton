import { postEsign } from "@/server/payments/routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** #16 POST /api/payments/[id]/esign (DESIGN §4.4). */
export const POST = postEsign;
