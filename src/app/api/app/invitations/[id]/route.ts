import { revokeInvitation } from "@/server/identity/app-invitations";

/** DELETE /api/app/invitations/:id → revoke (SAAS §3.6, WP19·3). */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const DELETE = revokeInvitation;
