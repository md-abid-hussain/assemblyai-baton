import { getPayment } from "@/server/payments/routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** #15 GET /api/payments/[id][?reconcile=1] (DESIGN §4.4, §5.12). Logic: src/server/payments/routes.ts. */
export const GET = getPayment;
