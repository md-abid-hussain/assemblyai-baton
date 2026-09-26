import { publishRelay } from "@/server/publish/routes";

/**
 * POST /api/relays/:id/publish → publish the relay as a stored AssemblyAI agent (PLATFORM §8.1; WP18·1).
 *
 * WP14b's path, mounted here at G2b: `docs/notes/requests/wp18-to-wp14b.md` §1 (WP18's every other route was already
 * mounted on its own branch). The handler lives in `src/server/publish/routes.ts`.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = publishRelay;
