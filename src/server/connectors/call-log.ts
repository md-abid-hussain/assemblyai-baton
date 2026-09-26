import "server-only";

import { createHash, randomBytes } from "node:crypto";

import type { ConnectorCallRecord } from "@/core/contracts/ext/wp16-connectors";

/**
 * The `connector_calls` log (PLATFORM §2.4, §6.2 "Logging", §6.3 step 5).
 *
 * It stores only status, ms, byte counts, the args hash and the agent-visible result (for the 30 s gateway dedupe),
 * never header values, secret values or raw responses. Two implementations of one port:
 * - `MemoryConnectorCallLog` (tests, and dev without a DB);
 * - `PgConnectorCallLog` (raw parameterised SQL on a `pg` pool against the 0001 table, which WP14b's migration
 *   creates; no dependency on the drizzle schema, so it works as soon as 0001 is applied).
 */

export interface ConnectorCallLog {
  record(entry: Omit<ConnectorCallRecord, "id" | "createdAt"> & { createdAt?: Date }): Promise<ConnectorCallRecord>;
  /** The newest `ok` call with this `(takeoverId, toolName, argsHash)` at or after `since`, or null (gateway dedupe). */
  findRecent(q: { takeoverId: string; toolName: string; argsHash: string; since: Date }): Promise<ConnectorCallRecord | null>;
}

/** The gateway dedupe window (PLATFORM §6.3 step 5). */
export const DEDUPE_WINDOW_MS = 30_000;

/** Canonical JSON: object keys sorted recursively, so `{a,b}` and `{b,a}` hash alike. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v ?? null);
}

/** sha256 hex of the canonical `{tool, args}`: the `connector_calls.args_hash`. */
export function argsHash(toolName: string, args: unknown): string {
  return createHash("sha256").update(canonicalJson({ tool: toolName, args })).digest("hex");
}

export function newConnectorCallId(): string {
  return `cc_${randomBytes(10).toString("hex")}`;
}

export class MemoryConnectorCallLog implements ConnectorCallLog {
  readonly rows: ConnectorCallRecord[] = [];
  constructor(private readonly max = 5000) {}
  async record(entry: Omit<ConnectorCallRecord, "id" | "createdAt"> & { createdAt?: Date }): Promise<ConnectorCallRecord> {
    const row: ConnectorCallRecord = { ...entry, id: newConnectorCallId(), createdAt: entry.createdAt ?? new Date() };
    this.rows.push(row);
    if (this.rows.length > this.max) this.rows.splice(0, this.rows.length - this.max);
    return row;
  }
  async findRecent(q: { takeoverId: string; toolName: string; argsHash: string; since: Date }): Promise<ConnectorCallRecord | null> {
    for (let i = this.rows.length - 1; i >= 0; i--) {
      const r = this.rows[i]!;
      if (r.createdAt < q.since) continue;
      if (r.takeoverId === q.takeoverId && r.toolName === q.toolName && r.argsHash === q.argsHash && r.status === "ok") return r;
    }
    return null;
  }
}

/** The subset of `pg.Pool` we use (so tests can pass a `pg.Client` or a pool). */
export interface PgQueryable {
  query<R extends Record<string, unknown> = Record<string, unknown>>(text: string, values?: unknown[]): Promise<{ rows: R[] }>;
}

type CallRow = {
  id: string; case_id: string | null; takeover_id: string | null; relay_version_id: string | null; publication_id: string | null;
  connector_id: string; tool_name: string; mode: string; status: string; http_status: number | null; ms: number;
  req_bytes: number; res_bytes: number; args_hash: string | null; result: Record<string, unknown> | null;
  error_code: string | null; created_at: Date;
};

const COLS = "id, case_id, takeover_id, relay_version_id, publication_id, connector_id, tool_name, mode, status, http_status, ms, req_bytes, res_bytes, args_hash, result, error_code, created_at";

function fromRow(r: CallRow): ConnectorCallRecord {
  return {
    id: r.id, caseId: r.case_id, takeoverId: r.takeover_id, relayVersionId: r.relay_version_id, publicationId: r.publication_id,
    connectorId: r.connector_id, toolName: r.tool_name, mode: r.mode as ConnectorCallRecord["mode"],
    status: r.status as ConnectorCallRecord["status"], httpStatus: r.http_status, ms: r.ms, reqBytes: r.req_bytes,
    resBytes: r.res_bytes, argsHash: r.args_hash, result: r.result, errorCode: r.error_code, createdAt: new Date(r.created_at),
  };
}

export class PgConnectorCallLog implements ConnectorCallLog {
  constructor(private readonly db: PgQueryable) {}
  async record(entry: Omit<ConnectorCallRecord, "id" | "createdAt"> & { createdAt?: Date }): Promise<ConnectorCallRecord> {
    const { rows } = await this.db.query<CallRow>(
      `insert into connector_calls (${COLS})
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16,$17)
       returning ${COLS}`,
      [
        newConnectorCallId(), entry.caseId, entry.takeoverId, entry.relayVersionId, entry.publicationId, entry.connectorId,
        entry.toolName, entry.mode, entry.status, entry.httpStatus, Math.round(entry.ms), entry.reqBytes, entry.resBytes,
        entry.argsHash, entry.result === null ? null : JSON.stringify(entry.result), entry.errorCode, entry.createdAt ?? new Date(),
      ],
    );
    return fromRow(rows[0]!);
  }
  async findRecent(q: { takeoverId: string; toolName: string; argsHash: string; since: Date }): Promise<ConnectorCallRecord | null> {
    const { rows } = await this.db.query<CallRow>(
      `select ${COLS} from connector_calls
        where takeover_id = $1 and tool_name = $2 and args_hash = $3 and created_at >= $4 and status = 'ok'
        order by created_at desc limit 1`,
      [q.takeoverId, q.toolName, q.argsHash, q.since],
    );
    return rows[0] ? fromRow(rows[0]) : null;
  }
}
