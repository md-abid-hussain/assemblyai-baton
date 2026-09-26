import { leaveOrg } from "@/server/identity/app-orgs";

/** POST /api/app/orgs/:id/leave → any member except the last owner (SAAS §3.5, WP19·3). */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = leaveOrg;
