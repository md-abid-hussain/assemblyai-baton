import "server-only";

/**
 * server/publish/gateway.ts - `POST /api/connectors/pub/:pubId/:tool` (PLATFORM §6.6, §8.3; WP18·1).
 *
 * AssemblyAI calls this from the stored agent's HTTP tools. WP18·0's P-2 probe pinned exactly what arrives:
 * `content-type: application/json`, the body is **the raw args object** (no wrapper, no call id, no session id), and
 * **there is no provider session/call/request id header and no signature**. So the gateway:
 *
 *  1. checks `X-Changeover-Key` against `relay_publications.key_hash` (constant time) → 401 `E_PUB_KEY`;
 *  2. binds the call to the publication's single active run (`active_run_id`, §8.3) → `{status:"no_active_call"}`
 *     with HTTP 200, because the body is what the agent reads and a non-2xx would just make it apologise;
 *  3. dedupes on `(takeoverId, tool, argsHash)` within 30 s and replays the stored body, so a retried `payment_link`
 *     never creates a second checkout (§6.3 step 5: the published gateway gets no `call_id` to key on);
 *  4. runs WP16's `RelayToolService`, which owns the stage gate (fail-closed `not_available`), arg validation and
 *     dispatch, with `ctx.workspaceId` = **the publication's org**, never the visitor's (§6.2 "whose secrets");
 *  5. answers with the tool result plus, when the stage changed, `next_step` at the TOP LEVEL of the JSON body.
 *
 * Every call also heartbeats the run lease, so a talking agent keeps its slot.
 */
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { nanoid } from "nanoid";

import { CONNECTOR_HEADERS } from "../../core/contracts/v2/api";
import {
  PublishedCallRecordSchema, PUBLISHED_DEDUPE_MS, PUBLISHED_MAX_TOOL_CALLS_PER_RUN, type PublishedCallRecord,
  type PublishedToolContext,
} from "../../core/contracts/ext/wp18-publish";
import type { Stage } from "../../core/contracts/case";
import { cases, connectorCalls, takeovers } from "../db/schema";
import { log } from "../log";
import { canonicalJson, sha256Hex } from "../relays/canonical";
import type { PublishDeps } from "./deps";
import { publicationKeyMatches } from "./keys";
import type { PgPublisher, PublicationJoin } from "./service";

const gwLog = log.child({ component: "publish-gateway" });

export const TOOL_NAME_RE = /^[a-z][a-z0-9_]{1,39}$/;

export interface GatewayAnswer {
  status: number;
  body: Record<string, unknown>;
}

const ok = (body: Record<string, unknown>): GatewayAnswer => ({ status: 200, body });

/** `sha256(canonicalJson(args))`: the dedupe key, since AssemblyAI sends no call id (WP18·0 P-2). */
export const argsHashOf = (args: unknown): string => sha256Hex(canonicalJson(args ?? {}));

export interface GatewayInput {
  publicationId: string;
  tool: string;
  key: string | null;
  /** The parsed request body: the raw args object. */
  args: unknown;
  origin: string;
}

export class PublishGateway {
  constructor(
    private readonly d: PublishDeps,
    private readonly publisher: PgPublisher,
  ) {}

  /** Read the key header exactly as the stored agent sends it. */
  static keyOf(headers: Headers): string | null {
    return headers.get(CONNECTOR_HEADERS.pubKey) ?? headers.get(CONNECTOR_HEADERS.pubKey.toLowerCase());
  }

  async handle(i: GatewayInput): Promise<GatewayAnswer> {
    if (!TOOL_NAME_RE.test(i.tool)) return { status: 404, body: { error: { code: "E_NOT_FOUND", message: "No such tool." } } };
    const j = await this.publisher.byId(i.publicationId);
    if (!j || j.pub.deletedAt || (j.pub.status !== "live" && j.pub.status !== "creating")) {
      return { status: 404, body: { error: { code: "E_NOT_FOUND", message: "No such publication." } } };
    }
    if (!publicationKeyMatches(i.key, j.pub.keyHash)) {
      gwLog.warn("published tool call with a bad key", { publicationId: j.pub.id, tool: i.tool });
      return { status: 401, body: { error: { code: "E_PUB_KEY", message: "This tool call is not authorized." } } };
    }

    const takeoverId = this.publisher.activeRunOf(j.pub);
    if (!takeoverId) return ok({ status: "no_active_call" });

    const args = i.args && typeof i.args === "object" && !Array.isArray(i.args) ? (i.args as Record<string, unknown>) : null;
    if (!args) return ok({ status: "failed", error: "bad_arguments" });

    const hash = argsHashOf(args);
    const replay = await this.storedResult(takeoverId, i.tool, hash);
    if (replay) {
      gwLog.info("published tool call deduped", { publicationId: j.pub.id, tool: i.tool, takeoverId });
      await this.publisher.heartbeat(j.pub.id, takeoverId);
      return ok(replay.body);
    }

    const run = await this.runOf(takeoverId);
    if (!run) return ok({ status: "no_active_call" });
    if (run.calls >= PUBLISHED_MAX_TOOL_CALLS_PER_RUN) return ok({ status: "failed", error: "too_many_calls" });

    const tools = this.d.tools();
    if (!tools) {
      gwLog.error("no RelayToolService is wired; the published tool could not run", { publicationId: j.pub.id, tool: i.tool });
      return ok({ status: "unavailable" });
    }

    const ctx: PublishedToolContext = {
      caseId: run.caseId,
      takeoverId,
      callId: null,
      visitorId: run.visitorId,
      origin: i.origin,
      mode: "published",
      publicationId: j.pub.id,
      workspaceId: j.workspaceId,
      orgId: j.workspaceId,
    };

    const startedAt = this.d.now();
    let record: PublishedCallRecord;
    let status: "ok" | "error" = "ok";
    try {
      const outcome = await tools.handle(i.tool, args, ctx);
      const body: Record<string, unknown> = { ...outcome.result };
      if (outcome.nextStep) body.next_step = outcome.nextStep;
      record = {
        body,
        stage: (outcome.stage ?? null) as Stage | null,
        nextStep: outcome.nextStep ?? null,
        ui: outcome.ui ? { ...outcome.ui } : null,
      };
      if (typeof body.status === "string" && body.status !== "ok" && body.status !== "link_sent") status = "error";
    } catch (err) {
      gwLog.error("published tool call failed", { publicationId: j.pub.id, tool: i.tool, takeoverId, err });
      status = "error";
      record = { body: { status: "failed" }, stage: null, nextStep: null, ui: null };
    }

    await this.recordCall({ j, takeoverId, caseId: run.caseId, tool: i.tool, hash, ms: Math.max(0, Math.round(this.d.now() - startedAt)), status, record });
    await this.publisher.heartbeat(j.pub.id, takeoverId);
    return ok(record.body);
  }

  /** The same `(takeover, tool, args)` inside the dedupe window: the stored body, executed nothing. */
  private async storedResult(takeoverId: string, tool: string, hash: string): Promise<PublishedCallRecord | null> {
    const since = new Date(this.d.now() - PUBLISHED_DEDUPE_MS);
    const [row] = await this.d.db
      .select({ result: connectorCalls.result })
      .from(connectorCalls)
      .where(
        and(
          eq(connectorCalls.takeoverId, takeoverId),
          eq(connectorCalls.toolName, tool),
          eq(connectorCalls.argsHash, hash),
          gte(connectorCalls.createdAt, since),
        ),
      )
      .orderBy(desc(connectorCalls.createdAt))
      .limit(1);
    const parsed = row?.result ? PublishedCallRecordSchema.safeParse(row.result) : null;
    return parsed?.success ? (parsed.data as PublishedCallRecord) : null;
  }

  /** The run behind the active takeover, and how many gateway calls it has made. */
  private async runOf(takeoverId: string): Promise<{ caseId: string; visitorId: string; relayVersionId: string | null; calls: number } | null> {
    const [t] = await this.d.db
      .select({ caseId: takeovers.caseId, outcome: takeovers.outcome, visitorId: cases.visitorId, relayVersionId: cases.relayVersionId })
      .from(takeovers)
      .innerJoin(cases, eq(cases.id, takeovers.caseId))
      .where(eq(takeovers.id, takeoverId));
    if (!t || t.outcome) return null;
    const [c] = await this.d.db
      .select({ n: sql<number>`count(*)::int`.mapWith(Number) })
      .from(connectorCalls)
      .where(eq(connectorCalls.takeoverId, takeoverId));
    return { caseId: t.caseId, visitorId: t.visitorId, relayVersionId: t.relayVersionId, calls: c?.n ?? 0 };
  }

  private async recordCall(i: {
    j: PublicationJoin;
    takeoverId: string;
    caseId: string;
    tool: string;
    hash: string;
    ms: number;
    status: "ok" | "error";
    record: PublishedCallRecord;
  }): Promise<void> {
    const connectorId = i.j.blueprint.connectors.find((c) => "toolName" in c && c.toolName === i.tool)?.id ?? i.tool;
    await this.d.db.insert(connectorCalls).values({
      id: `cc_${nanoid()}`,
      caseId: i.caseId,
      takeoverId: i.takeoverId,
      relayVersionId: i.j.versionId,
      publicationId: i.j.pub.id,
      connectorId,
      toolName: i.tool,
      mode: "published",
      status: i.status,
      ms: i.ms,
      argsHash: i.hash,
      result: i.record as unknown as Record<string, unknown>,
      createdAt: new Date(this.d.now()),
    });
  }
}
