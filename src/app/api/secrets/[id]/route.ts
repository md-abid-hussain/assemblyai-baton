import { deleteSecret } from "@/server/secrets/routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** `DELETE /api/secrets/:id` (PLATFORM §6.4; WP16·3). 204, whether or not this workspace had that secret. */
export const DELETE = deleteSecret;
