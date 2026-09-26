import { deleteMember, patchMember } from "@/server/identity/app-members";

/** PATCH /api/app/members/:userId → role change; DELETE → remove or leave (SAAS §3.7, WP19·3). */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const PATCH = patchMember;
export const DELETE = deleteMember;
