import { listAudit } from "@/server/identity/app-audit";

/** GET /api/app/audit?cursor&actor&action&from&to → the audit log, admin+ (SAAS §9, WP19·3). */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = listAudit;
