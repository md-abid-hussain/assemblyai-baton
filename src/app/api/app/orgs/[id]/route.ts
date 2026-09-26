import { deleteOrg, patchOrg } from "@/server/identity/app-orgs";

/** PATCH /api/app/orgs/:id → rename (admin+); DELETE → delete (owner, typed confirmation). SAAS §3.5, WP19·3. */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const PATCH = patchOrg;
export const DELETE = deleteOrg;
