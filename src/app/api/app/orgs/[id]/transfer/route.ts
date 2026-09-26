import { transferOrg } from "@/server/identity/app-orgs";

/** POST /api/app/orgs/:id/transfer → owner to an existing admin (SAAS §3.5, WP19·3). */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = transferOrg;
