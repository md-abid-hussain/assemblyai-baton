import "server-only";

/**
 * Prefixed ids for the Better Auth tables (SAAS §2.2, §3.1 `advanced.database.generateId`).
 *
 * `[VERIFY b]` (WP19·2, PASS): Better Auth calls `generateId({ model })` with the **singular model name**
 * (`"organization"`, `"user"`, …), not the plural table name, so this map keys on the model.
 *
 * Nothing in the product depends on a prefix (SAAS §2.2: "an opaque string"); they exist so a log line, a support
 * question or a `changeover.lock.json` file says what an id is. An unmapped model falls back to a bare nanoid,
 * which keeps this additive when a later plugin brings its own tables.
 */
import { nanoid } from "nanoid";

/** Model → prefix. Deliberately small: only the models our own config creates. */
export const ID_PREFIXES: Readonly<Record<string, string>> = Object.freeze({
  user: "usr_",
  session: "ses_",
  account: "acc_",
  verification: "ver_",
  organization: "org_",
  member: "mem_",
  invitation: "inv_",
  // WP22's `@better-auth/api-key` plugin brings this one; the key VALUE is the plugin's `cko_…`, this is the row id.
  apikey: "akr_",
});

export function prefixedId(model: string): string {
  return `${ID_PREFIXES[model] ?? ""}${nanoid()}`;
}

/** Ids for our own tables (SAAS §2.7 comments: `use_`, `evt_`, `whe_`, `whd_`, `aud_`). */
export const saasId = (prefix: string): string => `${prefix}${nanoid()}`;
