import "server-only";

/**
 * Storage for connector secrets: one port, two implementations.
 * - `MemorySecretRepo` (tests; dev without a DB);
 * - `PgSecretRepo`: raw parameterised SQL on a `pg` pool against `connector_secrets` from migration 0001 (WP14b owns
 *   the migration; the table is PLATFORM §2.4 verbatim), so it needs nothing from the drizzle schema.
 * Rows hold ciphertext only; the store (./store.ts) does all crypto.
 */

export interface SecretRow {
  id: string;
  workspaceId: string;
  name: string;
  ciphertext: Buffer;
  iv: Buffer;
  tag: Buffer;
  keyVersion: number;
  createdAt: Date;
  expiresAt: Date;
}

export interface SecretRepo {
  /** Insert, or replace the sealed value of the existing `(workspaceId, name)` row, KEEPING its id. Returns the row. */
  upsert(row: SecretRow): Promise<SecretRow>;
  getById(workspaceId: string, id: string): Promise<SecretRow | null>;
  getByName(workspaceId: string, name: string): Promise<SecretRow | null>;
  /** Rows with `expiresAt > now`, oldest first. */
  listLive(workspaceId: string, now: Date): Promise<SecretRow[]>;
  remove(workspaceId: string, id: string): Promise<boolean>;
  /** Delete expired rows (the purge job); returns how many. */
  purgeExpired(now: Date): Promise<number>;
}

export class MemorySecretRepo implements SecretRepo {
  private readonly rows = new Map<string, SecretRow>();
  async upsert(row: SecretRow): Promise<SecretRow> {
    const existing = await this.getByName(row.workspaceId, row.name);
    const saved = { ...row, id: existing ? existing.id : row.id };
    this.rows.set(saved.id, saved);
    return { ...saved };
  }
  async getById(workspaceId: string, id: string): Promise<SecretRow | null> {
    const r = this.rows.get(id);
    return r && r.workspaceId === workspaceId ? { ...r } : null;
  }
  async getByName(workspaceId: string, name: string): Promise<SecretRow | null> {
    for (const r of this.rows.values()) if (r.workspaceId === workspaceId && r.name === name) return { ...r };
    return null;
  }
  async listLive(workspaceId: string, now: Date): Promise<SecretRow[]> {
    return [...this.rows.values()]
      .filter((r) => r.workspaceId === workspaceId && r.expiresAt > now)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .map((r) => ({ ...r }));
  }
  async remove(workspaceId: string, id: string): Promise<boolean> {
    const r = this.rows.get(id);
    if (!r || r.workspaceId !== workspaceId) return false;
    return this.rows.delete(id);
  }
  async purgeExpired(now: Date): Promise<number> {
    let n = 0;
    for (const [id, r] of this.rows) if (r.expiresAt <= now && this.rows.delete(id)) n++;
    return n;
  }
  /** Test hook: every stored row (ciphertext only). */
  dump(): SecretRow[] {
    return [...this.rows.values()].map((r) => ({ ...r }));
  }
}

/** The subset of `pg.Pool` we use. */
export interface PgQueryable {
  query<R extends Record<string, unknown> = Record<string, unknown>>(text: string, values?: unknown[]): Promise<{ rows: R[]; rowCount?: number | null }>;
}

type Row = {
  id: string; workspace_id: string; name: string; ciphertext: Buffer; iv: Buffer; tag: Buffer; key_version: number;
  created_at: Date; expires_at: Date;
};
const COLS = "id, workspace_id, name, ciphertext, iv, tag, key_version, created_at, expires_at";
const fromRow = (r: Row): SecretRow => ({
  id: r.id, workspaceId: r.workspace_id, name: r.name, ciphertext: r.ciphertext, iv: r.iv, tag: r.tag,
  keyVersion: r.key_version, createdAt: new Date(r.created_at), expiresAt: new Date(r.expires_at),
});

export class PgSecretRepo implements SecretRepo {
  constructor(private readonly db: PgQueryable) {}
  async upsert(row: SecretRow): Promise<SecretRow> {
    const { rows } = await this.db.query<Row>(
      `insert into connector_secrets (${COLS}) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       on conflict (workspace_id, name) do update set
         ciphertext = excluded.ciphertext, iv = excluded.iv, tag = excluded.tag, key_version = excluded.key_version,
         created_at = excluded.created_at, expires_at = excluded.expires_at
       returning ${COLS}`,
      [row.id, row.workspaceId, row.name, row.ciphertext, row.iv, row.tag, row.keyVersion, row.createdAt, row.expiresAt],
    );
    return fromRow(rows[0]!);
  }
  async getById(workspaceId: string, id: string): Promise<SecretRow | null> {
    const { rows } = await this.db.query<Row>(`select ${COLS} from connector_secrets where workspace_id = $1 and id = $2`, [workspaceId, id]);
    return rows[0] ? fromRow(rows[0]) : null;
  }
  async getByName(workspaceId: string, name: string): Promise<SecretRow | null> {
    const { rows } = await this.db.query<Row>(`select ${COLS} from connector_secrets where workspace_id = $1 and name = $2`, [workspaceId, name]);
    return rows[0] ? fromRow(rows[0]) : null;
  }
  async listLive(workspaceId: string, now: Date): Promise<SecretRow[]> {
    const { rows } = await this.db.query<Row>(
      `select ${COLS} from connector_secrets where workspace_id = $1 and expires_at > $2 order by created_at asc, id asc`,
      [workspaceId, now],
    );
    return rows.map(fromRow);
  }
  async remove(workspaceId: string, id: string): Promise<boolean> {
    const r = await this.db.query(`delete from connector_secrets where workspace_id = $1 and id = $2`, [workspaceId, id]);
    return (r.rowCount ?? 0) > 0;
  }
  async purgeExpired(now: Date): Promise<number> {
    const r = await this.db.query(`delete from connector_secrets where expires_at <= $1`, [now]);
    return r.rowCount ?? 0;
  }
}
