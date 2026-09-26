import "server-only";

/**
 * app/app/relays/studio-config.ts - the deployment switches the Studio needs, read on the server.
 *
 * DESIGN §3.4: **there is no `NEXT_PUBLIC_*` variable in this codebase**, so a flag reaches the browser as a prop on
 * a client component and in no other way.
 *
 *   STUDIO_MODE   full | readonly    the K-G3 fallback (SAAS §15; PLATFORM §13.4)
 *   CODE_EDITOR   monaco | textarea  the K-MONACO fallback (SAAS §5.5.1)
 *
 * The raw strings are handed over unparsed and `client/studio/capabilities.ts` parses them, so the rule "anything
 * unrecognised means the safe default" is written once, in the module the unit tests can reach. This file imports
 * nothing from `src/client` on purpose: those modules carry `import "client-only"`, which throws under the
 * `react-server` condition a server component is compiled with.
 */
export interface StudioEnv {
  studioMode: string | null;
  codeEditor: string | null;
  /**
   * The active org's plan, which gates "Add HTTP action" in Configure (SAAS §5.6). It is **not** an environment
   * variable and never will be: it is WP21's `EntitlementView.plan` for the request's principal, and it stays `null`
   * until that read model exists — `client/studio/capabilities.ts` reads `null` as "no plan layer here", not as the
   * cheapest plan. See `docs/notes/requests/wp15-to-wp21.md`.
   */
  plan: string | null;
}

export function studioEnv(): StudioEnv {
  return {
    studioMode: process.env.STUDIO_MODE ?? null,
    codeEditor: process.env.CODE_EDITOR ?? null,
    plan: null,
  };
}
