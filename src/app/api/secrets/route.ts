import { listSecrets, putSecret } from "@/server/secrets/routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * `GET|POST /api/secrets` (PLATFORM §6.4; WP16·3). The list is names, ids and dates; the POST takes `{name, value}`
 * and answers with the same metadata. A value is never returned by either.
 */
export const GET = listSecrets;
export const POST = putSecret;
