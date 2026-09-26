import "server-only";

/**
 * Org scoping for the read models (SAAS §6.2, §10.1 rule 1).
 *
 * Every read model takes `orgId` from the `Principal` and nothing else, and turns it into exactly one SQL
 * predicate here. There is no second way to reach a row.
 *
 * **Two schema generations.** SAAS §2.7's `0002_saas` adds `cases.org_id`; WP19 owns that migration and it is not
 * on `main` yet. Until it is, a run is reachable only through `cases.visitor_id`, which is what `ws_<visitorId>`
 * means (SAAS §2.6). So:
 *
 * | org id | `cases.org_id` exists | predicate |
 * |---|---|---|
 * | `ws_<vid>` (legacy / device) | no  | `visitor_id = vid` |
 * | `ws_<vid>` (legacy / device) | yes | `org_id = orgId OR (org_id IS NULL AND visitor_id = vid)` |
 * | a real org (`org_…`)         | no  | nothing matches (the column that would carry it does not exist yet) |
 * | a real org (`org_…`)         | yes | `org_id = orgId` |
 *
 * The second row is the one that keeps the judge path honest before the claim runs: a Baton run started on this
 * device, whose case row has no org yet, still appears in the device's own workspace (SAAS §2.6, TASKS-v3 §7
 * WP20 acceptance 2). **A real org never falls back to the device**, so a shared browser can never leak one
 * person's guest work into another person's org — the confirmation card of §2.6 R1 is the only path for that.
 */
import { sql, type SQL } from "drizzle-orm";

import type { Db } from "../db";

/** `ws_<visitorId>` → `visitorId`; anything else → null (SAAS §2.6, `workspaceOf`). */
export function visitorIdOfWorkspace(orgId: string): string | null {
  return orgId.startsWith("ws_") && orgId.length > 3 ? orgId.slice(3) : null;
}

/** A predicate that can never be true, for "this org cannot own any row in this schema generation". */
const NEVER: SQL = sql`false`;

type Holder = { hasOrgId?: Promise<boolean> };
// One probe per process, like the db pool holder, so `next dev` reloads do not re-probe on every render.
const g = globalThis as typeof globalThis & { __wp20Schema?: Holder };
const holder: Holder = (g.__wp20Schema ??= {});

/** Has `0002_saas` run? Probed once, cached for the process. A failed probe reads as "no": the safe direction. */
export function casesHaveOrgId(db: Db): Promise<boolean> {
  return (holder.hasOrgId ??= db
    .execute(
      sql`select count(*)::int as n from information_schema.columns where table_schema = current_schema() and table_name = 'cases' and column_name = 'org_id'`,
    )
    .then((r) => Number((r.rows[0] as { n?: number } | undefined)?.n ?? 0) > 0)
    .catch(() => false));
}

/** Test seam: forget the probe (a test that creates the column mid-run, or resets the DB). */
export function resetSchemaProbe(): void {
  delete holder.hasOrgId;
}

/**
 * The one tenant predicate for `cases`. `orgId` comes from `Principal.orgId` and is never read from a request
 * body, query string or header (SAAS §10.1 rule 3).
 *
 * `alias` is the name the caller's `FROM` gave the `cases` table (the read models alias it `c`). The column
 * names are written literally because `cases.org_id` is not in the drizzle schema until WP19 regenerates it;
 * every *value* is still a bound parameter.
 */
export async function casesOrgFilter(db: Db, orgId: string, alias = "c"): Promise<SQL> {
  const col = (name: string) => sql.raw(`${quoteAlias(alias)}.${name}`);
  const vid = visitorIdOfWorkspace(orgId);
  if (!(await casesHaveOrgId(db))) return vid ? sql`${col("visitor_id")} = ${vid}` : NEVER;
  if (!vid) return sql`${col("org_id")} = ${orgId}`;
  return sql`(${col("org_id")} = ${orgId} or (${col("org_id")} is null and ${col("visitor_id")} = ${vid}))`;
}

/** Aliases come from this module's callers, never from a request; the guard is belt-and-braces against typos. */
function quoteAlias(alias: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(alias)) throw new Error(`unsafe table alias: ${alias}`);
  return alias;
}

/**
 * The `relays` equivalent. Relays carry `workspace_id` in both generations (the claim rewrites it in place,
 * SAAS §2.6 step 2), so this is a plain equality — it exists so callers never write the column name themselves.
 */
export const relayWorkspaceOf = (orgId: string): string => orgId;
