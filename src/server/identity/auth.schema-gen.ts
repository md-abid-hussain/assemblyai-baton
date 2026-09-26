/**
 * The entry point for `npx auth@1.7.6 generate` (SAAS §2.7). **Nothing imports this file at runtime.**
 *
 * Regenerate `src/server/db/schema-auth.ts` with:
 *
 * ```
 * NODE_OPTIONS=--conditions=react-server DATABASE_URL=postgres://unused \
 *   npx auth@1.7.6 generate --config src/server/identity/auth.schema-gen.ts \
 *                           --output src/server/db/schema-auth.ts --yes
 * ```
 *
 * Two things make this file necessary and one makes it safe:
 *
 * - the CLI refuses a config file that contains `import "server-only"`, and it wants a module-scope export named
 *   `auth`, while the real `auth.ts` is deliberately **lazy** (a deployment with no `BETTER_AUTH_SECRET` must still
 *   boot on the legacy path, §15);
 * - `--conditions=react-server` is what lets the transitive `server-only` imports resolve to their no-op build,
 *   the same flag `scripts/*` already use;
 * - it calls the real `buildAuth()`, so the generated schema can never drift from the config the server runs. The
 *   placeholder secret and URL never leave this process and are not credentials for anything.
 *
 * `getDb()` only constructs a lazy pool, so no connection is opened during generation.
 */
import { buildAuth } from "./auth";

/** The name the CLI looks for. */
export const auth = buildAuth("schema-generation-placeholder-secret-0000", "http://localhost:3190");
