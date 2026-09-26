import { createOrgRoute, listOrgs } from "@/server/identity/app-orgs";

/** GET /api/app/orgs → the switcher; POST → a new team org (SAAS §3.5, WP19·3). */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = listOrgs;
export const POST = createOrgRoute;
