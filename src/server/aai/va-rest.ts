/**
 * server/aai/va-rest.ts - WP8's Voice Agent REST port (TASKS WP8 "Provides"): `getSession`, `listSessions`,
 * `createAgent`, `deleteAgent`, `deleteSession`, plus paging for the F6 audit. A thin, injectable layer over WP0a's
 * `VoiceAgentRest` (src/server/aai/va-node.ts), so jobs and routes can be unit-tested with a fake.
 *
 * Nothing here opens a session or mints a token (those stay behind the limits helpers). Needs the API key, so it is
 * server-only; never log the key or a pre-signed artifact URL (the S3 signature is a bearer credential for 1 h).
 */
import "server-only";

import type { AgentDefinition, AgentRecord, SessionRecord } from "../../core/aai/voice-agent";
import { requireEnv } from "../env";
import { VoiceAgentRest, type RestOptions } from "./va-node";

export type { SessionRecord } from "../../core/aai/voice-agent";

/**
 * The query-parameter name that takes `response_metadata.next_cursor` on `GET /v1/sessions`. The docs are silent
 * (g0.md known gap). T-D1-0b (`scripts/day1/session-delete.ts --cursor`) probes it; see docs/notes/wp8.md.
 */
export const SESSIONS_CURSOR_PARAM = "cursor";

export class VaRestError extends Error {
  readonly status: number;
  constructor(label: string, status: number, body: unknown) {
    const text = typeof body === "string" ? body : JSON.stringify(body ?? null);
    super(`${label}: HTTP ${status} ${(text ?? "").slice(0, 200)}`);
    this.name = "VaRestError";
    this.status = status;
  }
  get notFound(): boolean {
    return this.status === 404;
  }
}

export interface SessionsPage {
  sessions: SessionRecord[];
  hasMore: boolean;
  nextCursor: string | null;
}

export interface VaRestPort {
  getSession(id: string): Promise<SessionRecord>;
  listSessions(q?: { limit?: number; cursor?: string | null }): Promise<SessionsPage>;
  /** Returns the HTTP status (2xx = deleted; 404 = already gone). */
  deleteSession(id: string): Promise<number>;
  createAgent(def: AgentDefinition): Promise<AgentRecord>;
  deleteAgent(id: string): Promise<number>;
}

export function createVaRest(apiKey: string, opts: RestOptions = {}): VaRestPort {
  const rest = new VoiceAgentRest(apiKey, opts);
  const ok = async <T>(method: string, path: string, label: string, body?: unknown): Promise<T> => {
    const r = await rest.request<T>(method, path, body, label);
    if (r.status < 200 || r.status >= 300) throw new VaRestError(label, r.status, r.body);
    return r.body;
  };
  return {
    getSession: (id) => ok<SessionRecord>("GET", `/sessions/${encodeURIComponent(id)}`, "get-session"),
    async listSessions(q = {}) {
      const p = new URLSearchParams();
      if (q.limit !== undefined) p.set("limit", String(q.limit));
      if (q.cursor) p.set(SESSIONS_CURSOR_PARAM, q.cursor);
      const body = await ok<{ sessions?: SessionRecord[]; has_more?: boolean; response_metadata?: { next_cursor?: string | null } }>(
        "GET",
        `/sessions${p.size ? `?${p}` : ""}`,
        "list-sessions",
      );
      return {
        sessions: Array.isArray(body?.sessions) ? body.sessions : [],
        hasMore: body?.has_more === true,
        nextCursor: body?.response_metadata?.next_cursor ?? null,
      };
    },
    async deleteSession(id) {
      return (await rest.request("DELETE", `/sessions/${encodeURIComponent(id)}`, undefined, "delete-session")).status;
    },
    createAgent: (def) => rest.createAgent(def),
    deleteAgent: (id) => rest.deleteAgent(id),
  };
}

/** The process default, from `ASSEMBLYAI_API_KEY` (throws `EnvError` naming the variable when it is missing). */
export function defaultVaRest(): VaRestPort {
  const { ASSEMBLYAI_API_KEY } = requireEnv("ASSEMBLYAI_API_KEY");
  return createVaRest(ASSEMBLYAI_API_KEY);
}

/**
 * Walk `GET /v1/sessions` newest-first, following `has_more` / `next_cursor`, until a page reaches sessions created
 * before `sinceMs` (or `maxPages`). A repeated cursor stops the walk (guards an ignored cursor parameter).
 */
export async function listSessionsSince(
  rest: VaRestPort,
  o: { sinceMs: number; pageSize?: number; maxPages?: number },
): Promise<{ sessions: SessionRecord[]; pages: number; truncated: boolean }> {
  const out: SessionRecord[] = [];
  const seen = new Set<string>();
  let cursor: string | null = null;
  let pages = 0;
  const maxPages = o.maxPages ?? 10;
  for (;;) {
    const page: SessionsPage = await rest.listSessions({ limit: o.pageSize ?? 50, cursor });
    pages++;
    let reachedOld = false;
    for (const s of page.sessions) {
      if (seen.has(s.id)) continue;
      seen.add(s.id);
      const created = s.created_at ? Date.parse(s.created_at) : NaN;
      if (Number.isFinite(created) && created < o.sinceMs) {
        reachedOld = true;
        continue;
      }
      out.push(s);
    }
    if (reachedOld || !page.hasMore || !page.nextCursor) return { sessions: out, pages, truncated: false };
    if (page.nextCursor === cursor || pages >= maxPages) return { sessions: out, pages, truncated: true };
    cursor = page.nextCursor;
  }
}

/** Artifact helpers (URLs are pre-signed for 1 h: fetch the record right before use; never persist or log them). */
export function artifactUrl(s: SessionRecord, type: "audio" | "timeline" | "metadata"): string | null {
  const a = (s.artifacts ?? []).find((x) => x.type === type);
  return a && typeof a.url === "string" && a.url ? a.url : null;
}
