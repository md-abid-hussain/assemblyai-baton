import { createInvitation, listInvitationsRoute } from "@/server/identity/app-invitations";

/** GET /api/app/invitations → pending links; POST → create one (SAAS §3.6, WP19·3). */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = listInvitationsRoute;
export const POST = createInvitation;
