import "server-only";

/**
 * `SecretRebinder` (SAAS §2.6 step 4, §14; WP16 registers it). WP16·3.
 *
 * When a guest device workspace (`ws_<visitorId>`) is claimed by a real org, its cases, relays and drafts simply
 * change their `workspace_id`. Secrets cannot: the AES-GCM **AAD binds each ciphertext to `(workspace, name)`**
 * (`crypto.ts`), so a row moved with an UPDATE would decrypt to nothing and the relay would refuse its own
 * connector calls. So every row is opened with the old AAD and re-sealed with the new one, **keeping its `sec_…`
 * id** — blueprint refs (`{ "$secret": "sec_…" }`) stay valid, which is the whole point of the exercise.
 *
 * It runs inside the caller's transaction (`claim.ts` passes its Drizzle `tx`), so a claim that rolls back leaves
 * the secrets exactly where they were. Plaintexts live in local variables for the length of one loop iteration and
 * are never logged, returned or re-registered anywhere.
 *
 * Two deliberate skips, both silent to the user and counted out of the return value:
 *  - a name the target org already uses: the org's own secret wins (and the unique index would refuse it anyway);
 *  - a row that no longer opens (the key was rotated): it is left to expire, exactly as `resolve` treats it today.
 */
import { sql } from "drizzle-orm";

import type { SecretRebinder } from "../../core/contracts/v3/services";
import { getDb, type Db } from "../db/client";
import { log } from "../log";
import { setSecretRebinder } from "../saas/ports";
import { openSecret, sealSecret, secretAad, secretKeyringFromEnv, type SecretKeyring } from "./crypto";

const rebindLog = log.child({ component: "secrets" });

/** Anything that can run SQL for us: the pool handle, or the Drizzle transaction the caller already opened. */
type Runner = Pick<Db, "execute">;

interface Row {
  id: string;
  name: string;
  ciphertext: Buffer;
  iv: Buffer;
  tag: Buffer;
  key_version: number;
}

const isRunner = (x: unknown): x is Runner =>
  typeof x === "object" && x !== null && typeof (x as { execute?: unknown }).execute === "function";

export interface SecretRebinderDeps {
  db?: () => Db;
  keyring?: () => SecretKeyring;
}

export class ConnectorSecretRebinder implements SecretRebinder {
  private readonly dbOf: () => Db;
  private readonly ringFactory: () => SecretKeyring;

  constructor(deps: SecretRebinderDeps = {}) {
    this.dbOf = deps.db ?? getDb;
    this.ringFactory = deps.keyring ?? (() => secretKeyringFromEnv());
  }

  async rebind(fromWs: string, toWs: string, tx?: unknown): Promise<number> {
    if (!fromWs || !toWs || fromWs === toWs) return 0;
    const run: Runner = isRunner(tx) ? tx : this.dbOf();
    const found = await run.execute(
      sql`select id, name, ciphertext, iv, tag, key_version from connector_secrets where workspace_id = ${fromWs} order by created_at`,
    );
    const rows = found.rows as unknown as Row[];
    if (rows.length === 0) return 0;

    const ring = this.ringFactory();
    let moved = 0;
    for (const row of rows) {
      const value = openSecret(
        ring,
        { ciphertext: toBuf(row.ciphertext), iv: toBuf(row.iv), tag: toBuf(row.tag), keyVersion: Number(row.key_version) },
        secretAad(fromWs, row.name),
      );
      if (value === null) {
        rebindLog.warn("a secret could not be re-bound (it will expire in place)", { id: row.id });
        continue;
      }
      const sealed = sealSecret(ring, value, secretAad(toWs, row.name));
      const updated = await run.execute(sql`
        update connector_secrets
           set workspace_id = ${toWs}, ciphertext = ${sealed.ciphertext}, iv = ${sealed.iv},
               tag = ${sealed.tag}, key_version = ${sealed.keyVersion}
         where id = ${row.id}
           and not exists (select 1 from connector_secrets t where t.workspace_id = ${toWs} and t.name = ${row.name})`);
      if ((updated.rowCount ?? 0) > 0) moved++;
    }
    if (moved > 0) rebindLog.info("secrets re-bound to the claimed org", { count: moved });
    return moved;
  }
}

/** `pg` gives bytea back as a Buffer; a driver that hands back a Uint8Array or a hex string is normalised here. */
function toBuf(v: unknown): Buffer {
  if (Buffer.isBuffer(v)) return v;
  if (v instanceof Uint8Array) return Buffer.from(v);
  if (typeof v === "string") return Buffer.from(v.startsWith("\\x") ? v.slice(2) : v, "hex");
  return Buffer.alloc(0);
}

let installed = false;

/** Register the real rebinder over the no-op default. Idempotent; called from the secrets composition root. */
export function installSecretRebinder(): void {
  if (installed) return;
  installed = true;
  setSecretRebinder(new ConnectorSecretRebinder());
}

/** Tests re-install after `resetSaasPorts()`. */
export function resetSecretRebinderInstall(): void {
  installed = false;
}
