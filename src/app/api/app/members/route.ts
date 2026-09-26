import { listMembersRoute } from "@/server/identity/app-members";

/** GET /api/app/members → the Members page list (SAAS §8.4, WP19·3). */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = listMembersRoute;
