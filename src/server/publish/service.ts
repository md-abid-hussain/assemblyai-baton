import "server-only";

/**
 * server/publish/service.ts - the publish service (PLATFORM §8.1, §8.3, §8.4; SAAS §12 WP18 row; WP18·1).
 *
 * `Publisher` (TASKS-v2 §5) over Postgres and `POST/DELETE /v1/agents`:
 *
 *  - **publish**: lint (incl. B1/K1/K2) → moderation (fail-closed) → plan + global guards → snapshot the version →
 *    compile the published config → create the stored agent → the row goes `live`;
 *  - **republish**: the NEW agent is created first, the row then points at it, and the OLD agent id moves to a
 *    tombstone row (`status:'deleting'`) that is deleted right away and retried by the purge job if that fails
 *    (PLATFORM §8.1 step 4). The publication id, share slug and key are stable across republishes, so the share link
 *    and the gateway URLs baked into the previous agent keep meaning the same thing;
 *  - **the single-run lock**: `active_run_id` / `active_until` with a 20 s heartbeat (§8.3);
 *  - **purge**: publications idle past their plan's `publicationIdleHours` are unpublished, pinned ones never
 *    (§8.4 + SAAS §4.1), and pending agent deletions are retried.
 *
 * Org hooks (SAAS §12): the caller is a `Principal` with `relay:publish`; the org is the relay's `workspace_id`
 * (`workspace_id` ≡ `organization.id`); `Entitlements.assertCount(org, "livePublications")` guards a NEW publication;
 * the `publish` usage record and the `relay.published` / `relay.unpublished` audit rows go through the v3 ports; and
 * `relay_publications.org_id` is written once WP19's `0002_saas` adds the column (`./org.ts`).
 */
import { and, asc, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { nanoid, customAlphabet } from "nanoid";

import type { AgentDefinition } from "../../core/aai/voice-agent";
import { BatonError } from "../../core/contracts/errors";
import { ID_PREFIXES, type Blueprint, type PublicationView } from "../../core/contracts/v2";
import type { CompiledRelay, Publisher } from "../../core/contracts/v2/services";
import type { AuditActor } from "../../core/contracts/v3/audit";
import type { Principal } from "../../core/contracts/v3/identity";
import { lintBlueprint } from "../../core/relay/lint";
import type { Db } from "../db/client";
import { relayPublications, relays, relayVersions } from "../db/schema";
import { log } from "../log";
import { hasLintErrors } from "../relays/kernel";
import { RelayError } from "../relays/http";
import { getAuditWriter, getEntitlements, getUsageMeter } from "../saas/ports";
import {
  firstStage, publishedAgentDefinition, redactPublishedConfig, type GatewayTarget,
} from "./config";
import type { PublishDeps } from "./deps";
import { hashPublicationKey, newPublicationKey, shareSlugFor } from "./keys";
import { writePublicationOrg } from "./org";

const pubLog = log.child({ component: "publish" });
const slugSuffix = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 6);

/**
 * PLATFORM §8.4 with the SAAS §4.1 split: **the global caps are the hard stop** ("the global 25 live agents and 10
 * publishes a day stay the hard stop"), while the per-workspace count and the idle lifetime became plan limits
 * (`livePublications`, `publicationIdleHours`) and are enforced through `Entitlements`.
 */
export const PUBLISH_LIMITS = {
  /** Live stored agents app-wide (every non-deleted row that owns an agent, tombstones included). */
  globalLiveAgents: 25,
  /** Publishes per day, app-wide, and the same number per visitor (the plan count is the real per-org limit). */
  publishesPerDayGlobal: 10,
  publishesPerVisitorPerDay: 10,
  /** The run lock: a 20 s heartbeat has to land three times inside the lease. */
  activeLeaseMs: 60_000,
  heartbeatMs: 20_000,
  /** PLATFORM §8.4's flat number, used when no plan says otherwise. */
  defaultIdleHours: 72,
} as const;

const LIVE_STATUSES = ["creating", "live"] as const;
/** Rows that own a real stored agent on the account (they count against the global cap). */
const AGENT_STATUSES = ["creating", "live", "deleting"] as const;

export type PublicationRow = typeof relayPublications.$inferSelect;

/** The HTTP status carried by `VoiceAgentHttpError` / `VaRestError`, without importing either. */
export const statusOf = (err: unknown): number | null => {
  const s = (err as { status?: unknown } | null)?.status;
  return typeof s === "number" ? s : null;
};

/**
 * `POST /v1/agents` refusals are not all the same.
 *
 * **Live-checked (WP18·1, `scripts/probes/publish-config-check.ts`, 2026-09-25):** AssemblyAI **resolves the HTTP
 * tool host at create time** and answers 422 `validation_error` "webhook URL host '…' does not resolve". That is a
 * configuration fault, not a blip: retrying it a minute later says the same thing, so it gets its own message.
 */
export function createAgentError(err: unknown, appUrl: string): BatonError {
  const status = statusOf(err);
  if (status !== null && status >= 400 && status < 500 && status !== 408 && status !== 429) {
    return new BatonError(
      "E_VA_CONFIG",
      `AssemblyAI refused this published agent. The published tools point at ${appUrl}, which has to be a public https host it can resolve.`,
    );
  }
  return new BatonError("E_VA_TRANSIENT", "AssemblyAI would not create the published agent. Try again in a minute.");
}

/** Who is publishing, for the audit row and the device limits. Built from the route's `Principal`. */
export interface PublishActor {
  orgId: string;
  visitorId: string;
  ipKey: string;
  userId: string | null;
  kind: Principal["kind"];
  label: string;
}

export const actorOf = (p: Principal): PublishActor => ({
  orgId: p.orgId ?? "",
  visitorId: p.visitorId,
  ipKey: p.ipKey,
  userId: p.userId,
  kind: p.kind,
  label: p.userId ?? p.apiKeyId ?? p.visitorId,
});

const auditActorOf = (a: PublishActor): AuditActor => ({
  type: a.kind === "api_key" ? "api_key" : a.userId ? "user" : "guest",
  id: a.userId ?? a.visitorId,
  label: a.label,
});

/** A publication with the bits every view needs, in one read. */
export interface PublicationJoin {
  pub: PublicationRow;
  version: number;
  versionId: string;
  blueprint: Blueprint;
  relayId: string;
  relaySlug: string;
  relayTitle: string;
  workspaceId: string;
  visibility: "private" | "unlisted" | "gallery";
  flagship: boolean;
}

export class PgPublisher implements Publisher {
  constructor(private readonly d: PublishDeps) {}

  private get db(): Db {
    return this.d.db;
  }

  // ------------------------------------------------------------------------------------------ reads

  private joinRows() {
    return this.db
      .select({
        pub: relayPublications,
        version: relayVersions.version,
        blueprint: relayVersions.blueprint,
        relaySlug: relays.slug,
        relayTitle: relays.title,
        workspaceId: relays.workspaceId,
        visibility: relays.visibility,
        flagship: relays.flagship,
      })
      .from(relayPublications)
      .innerJoin(relayVersions, eq(relayVersions.id, relayPublications.versionId))
      .innerJoin(relays, eq(relays.id, relayPublications.relayId));
  }

  private joinOf(r: Awaited<ReturnType<PgPublisher["joinRows"]>>[number]): PublicationJoin {
    return {
      pub: r.pub,
      version: r.version,
      versionId: r.pub.versionId,
      blueprint: r.blueprint as unknown as Blueprint,
      relayId: r.pub.relayId,
      relaySlug: r.relaySlug,
      relayTitle: r.relayTitle,
      workspaceId: r.workspaceId,
      visibility: r.visibility,
      flagship: r.flagship,
    };
  }

  /** The one live (or creating) publication of a relay, if any. */
  async liveForRelay(relayId: string): Promise<PublicationJoin | null> {
    const rows = await this.joinRows()
      .where(and(eq(relayPublications.relayId, relayId), isNull(relayPublications.deletedAt), inArray(relayPublications.status, [...LIVE_STATUSES])))
      .orderBy(desc(relayPublications.createdAt))
      .limit(1);
    return rows[0] ? this.joinOf(rows[0]) : null;
  }

  async byId(pubId: string): Promise<PublicationJoin | null> {
    const rows = await this.joinRows().where(eq(relayPublications.id, pubId)).limit(1);
    return rows[0] ? this.joinOf(rows[0]) : null;
  }

  async joinBySlug(slug: string): Promise<PublicationJoin | null> {
    const rows = await this.joinRows()
      .where(and(eq(relayPublications.shareSlug, slug), isNull(relayPublications.deletedAt), inArray(relayPublications.status, [...LIVE_STATUSES])))
      .limit(1);
    return rows[0] ? this.joinOf(rows[0]) : null;
  }

  /**
   * `PublicationView` for a stored row. `configRedacted` is the structural published config (names, the gateway URLs
   * and the header NAME only) rebuilt from the blueprint — the compiled prompt is not re-derived on a hot read; the
   * publish response and the share page carry the full redacted create body.
   */
  view(j: PublicationJoin, configRedacted?: Record<string, unknown>): PublicationView {
    return {
      id: j.pub.id,
      relayId: j.relayId,
      version: j.version,
      shareSlug: j.pub.shareSlug,
      agentId: j.pub.aaiAgentId,
      status: j.pub.status,
      mode: "stored_agent",
      configRedacted: configRedacted ?? this.structuralConfig(j),
    };
  }

  /** The published config as far as it can be told from the blueprint alone (no kernel, no prompt text). */
  private structuralConfig(j: PublicationJoin): Record<string, unknown> {
    const bp = j.blueprint;
    const names = [...new Set(bp.playbook.stages.flatMap((s) => s.tools))];
    const appUrl = (this.d.appUrl() ?? "").replace(/\/+$/, "");
    return {
      name: `changeover-${bp.meta.slug}`,
      voice: { voice_id: bp.playbook.voice },
      input: { transcription_mode: "balanced" },
      tools: names.map((name) => ({
        name,
        http: {
          url: `${appUrl}/api/connectors/pub/${j.pub.id}/${name}`,
          http_method: "POST",
          headers: [{ name: "X-Changeover-Key" }],
        },
      })),
    };
  }

  /** `RelayRegistry`'s `PublicationLookup`: what `RelayDetail.publication` shows. */
  async forRelay(relayId: string): Promise<PublicationView | null> {
    const j = await this.liveForRelay(relayId);
    return j ? this.view(j) : null;
  }

  async bySlug(slug: string): Promise<PublicationView | null> {
    const j = await this.joinBySlug(slug);
    if (!j) return null;
    return this.view(j, await this.fullRedactedConfig(j).catch(() => undefined));
  }

  /** The exact create body, redacted: needs the kernel, so callers that cannot afford a compile skip it. */
  async fullRedactedConfig(j: PublicationJoin): Promise<Record<string, unknown>> {
    const compiled = await this.d.engine.forVersion(j.versionId);
    return redactPublishedConfig(this.definitionFor(j.blueprint, compiled, j.version, { appUrl: this.requireAppUrl(), publicationId: j.pub.id, key: "" }));
  }

  // ------------------------------------------------------------------------------------------ publish

  private requireAppUrl(): string {
    const url = this.d.appUrl();
    if (!url || !/^https?:\/\//i.test(url)) {
      throw new BatonError("E_MAINTENANCE", "This deployment has no public URL, so AssemblyAI cannot reach the published tools yet.");
    }
    return url.replace(/\/+$/, "");
  }

  private definitionFor(bp: Blueprint, compiled: CompiledRelay, version: number, target: GatewayTarget): AgentDefinition {
    return publishedAgentDefinition({
      compiled,
      blueprint: bp,
      deployId: this.d.deployId(),
      target,
      name: `changeover-${bp.meta.slug}-v${version}`.slice(0, 80),
    });
  }

  /** `Publisher.publish`: the v2 signature. Routes use `publishFor`, which carries the org hooks. */
  async publish(relayId: string, ws: string): Promise<PublicationView> {
    const r = await this.publishFor(relayId, { orgId: ws, visitorId: ws.replace(/^ws_/, ""), ipKey: "", userId: null, kind: "visitor", label: ws });
    return r.view;
  }

  async publishFor(relayId: string, actor: PublishActor): Promise<{ view: PublicationView; configRedacted: Record<string, unknown>; shareUrl: string; version: number }> {
    const ws = actor.orgId;
    const appUrl = this.requireAppUrl();
    const row = await this.d.registry.ownRow(relayId, ws);

    // 1. the draft must be lint-clean before it is snapshotted (PLATFORM §8.1 step 1)
    const draft = this.d.registry.kernel.parse(row.draft);
    if (!draft.blueprint || hasLintErrors(draft.issues)) {
      throw new RelayError("E_LINT", "Fix the lint errors before you publish this relay.", { lint: draft.issues });
    }
    const snap = await this.d.registry.snapshotVersion(row.id);
    const existing = await this.liveForRelay(row.id);
    const pinned = existing?.pub.pinned ?? row.visibility === "gallery";

    // 2. the full rule lint with the context that is not in the blueprint: B1, K1 (gallery / pinned), K2 (secrets)
    const secretIds = this.d.secretIds ? await this.d.secretIds(ws).catch(() => undefined) : undefined;
    const issues = lintBlueprint(draft.blueprint, {
      visibility: row.visibility,
      pinnedPublication: pinned,
      flagship: row.flagship,
      ...(secretIds ? { secretIds } : {}),
    });
    if (hasLintErrors(issues)) {
      throw new RelayError("E_LINT", "This relay cannot be published yet: fix the errors below.", { lint: issues });
    }

    // 3. moderation, once per version; unavailable → 503 from the registry (fail-closed, PLATFORM §7.4)
    const moderation = await this.d.registry.moderate(snap.versionId);
    if (moderation.flagged) {
      throw new RelayError("E_MODERATION_FLAGGED", "This relay's text was flagged by the content check, so it cannot be published.", {
        body: { categories: moderation.categories },
      });
    }

    // 4. plan + global guards
    if (!existing) await getEntitlements().assertCount(ws, "livePublications");
    await this.assertGlobalRoom(existing?.pub.id ?? null);

    const compiled = await this.d.engine.forVersion(snap.versionId);
    const now = new Date(this.d.now());

    // 5. the row first (so the gateway URLs exist before the agent that carries them). The publication id and the
    // share slug are stable across republishes; the key is not, because only its hash is stored and a hash cannot be
    // put back into an agent definition. The new hash is therefore written in the SAME statement that swaps the new
    // agent in (step 6): until that lands, the live agent and its old key keep working.
    const pubId = existing?.pub.id ?? `${ID_PREFIXES.publication}${nanoid()}`;
    const key = newPublicationKey();
    if (!existing) {
      await this.db.insert(relayPublications).values({
        id: pubId,
        relayId: row.id,
        versionId: snap.versionId,
        shareSlug: shareSlugFor(row.slug, slugSuffix()),
        keyHash: hashPublicationKey(key),
        status: "creating",
        pinned: row.visibility === "gallery",
        lastUsedAt: now,
        createdAt: now,
      });
      await writePublicationOrg(this.db, pubId, ws);
    }

    const target: GatewayTarget = { appUrl, publicationId: pubId, key };
    const def = this.definitionFor(draft.blueprint, compiled, snap.version, target);

    let agentId: string;
    try {
      const created = await this.d.vaRest().createAgent(def);
      agentId = created.id;
    } catch (err) {
      if (!existing) await this.db.update(relayPublications).set({ status: "failed" }).where(eq(relayPublications.id, pubId));
      pubLog.error("could not create the stored agent", { pubId, err, status: statusOf(err) });
      throw createAgentError(err, appUrl);
    }

    // 6. the swap: the new agent, its key hash and the new version land together
    const oldAgentId = existing?.pub.aaiAgentId ?? null;
    await this.db
      .update(relayPublications)
      .set({ versionId: snap.versionId, aaiAgentId: agentId, keyHash: hashPublicationKey(key), status: "live", lastUsedAt: now, deletedAt: null })
      .where(eq(relayPublications.id, pubId));
    await this.db.update(relays).set({ status: "published", lastUsedAt: now }).where(eq(relays.id, row.id));
    if (existing) await writePublicationOrg(this.db, pubId, ws);

    // 7. republish: the old agent goes to a tombstone row, deleted now and retried by the purge job if that fails
    if (oldAgentId && oldAgentId !== agentId) await this.retireAgent(row.id, existing!.versionId, oldAgentId, now);

    await getUsageMeter()
      .record({ orgId: ws, kind: "publish", quantity: 1, relayId: row.id, idempotencyKey: `publish:${pubId}:${snap.version}` })
      .catch((err: unknown) => pubLog.warn("usage record failed", { pubId, err }));
    await getAuditWriter()
      .write({
        orgId: ws,
        actor: auditActorOf(actor),
        action: "relay.published",
        target: { type: "publication", id: pubId },
        metadata: { relayId: row.id, version: snap.version, agentId, republish: !!existing },
      })
      .catch((err: unknown) => pubLog.warn("audit write failed", { pubId, err }));

    const j = (await this.byId(pubId))!;
    const configRedacted = redactPublishedConfig(def);
    pubLog.info("published", { pubId, relayId: row.id, version: snap.version, republish: !!existing });
    return { view: this.view(j, configRedacted), configRedacted, shareUrl: `/a/${j.pub.shareSlug}`, version: snap.version };
  }

  /** The global live-agent cap (PLATFORM §8.4). `exceptId` is the row a republish is about to replace. */
  private async assertGlobalRoom(exceptId: string | null): Promise<void> {
    const [c] = await this.db
      .select({ n: sql<number>`count(*)::int`.mapWith(Number) })
      .from(relayPublications)
      .where(
        and(
          isNull(relayPublications.deletedAt),
          inArray(relayPublications.status, [...AGENT_STATUSES]),
          exceptId ? ne(relayPublications.id, exceptId) : sql`true`,
        ),
      );
    if ((c?.n ?? 0) >= PUBLISH_LIMITS.globalLiveAgents) {
      throw new BatonError(
        "E_RATE_LIMITED",
        `This demo keeps at most ${PUBLISH_LIMITS.globalLiveAgents} published agents live at once. Unpublish one, or try again later.`,
      );
    }
  }

  /** Move a superseded agent to a tombstone row and try to delete it now (retried by the purge job). */
  private async retireAgent(relayId: string, versionId: string, agentId: string, now: Date): Promise<void> {
    const id = `${ID_PREFIXES.publication}${nanoid()}`;
    await this.db.insert(relayPublications).values({
      id,
      relayId,
      versionId,
      shareSlug: `retired-${nanoid(12)}`,
      keyHash: "retired",
      status: "deleting",
      aaiAgentId: agentId,
      createdAt: now,
      lastUsedAt: now,
    });
    await this.deleteAgentRow(id, agentId);
  }

  /** `DELETE /v1/agents/{id}` → the row is `deleted`. A failure leaves it `deleting` for the purge job. */
  private async deleteAgentRow(pubId: string, agentId: string | null): Promise<boolean> {
    if (agentId) {
      try {
        const status = await this.d.vaRest().deleteAgent(agentId);
        if (status !== 204 && status !== 200 && status !== 404) throw new Error(`unexpected status ${status}`);
      } catch (err) {
        pubLog.warn("could not delete the stored agent; the purge job will retry", { pubId, err });
        await this.db.update(relayPublications).set({ status: "deleting" }).where(eq(relayPublications.id, pubId));
        return false;
      }
    }
    await this.db
      .update(relayPublications)
      .set({ status: "deleted", deletedAt: new Date(this.d.now()), activeRunId: null, activeUntil: null })
      .where(eq(relayPublications.id, pubId));
    return true;
  }

  // ------------------------------------------------------------------------------------------ unpublish

  async unpublish(pubId: string, ws: string): Promise<void> {
    await this.unpublishFor(pubId, { orgId: ws, visitorId: ws.replace(/^ws_/, ""), ipKey: "", userId: null, kind: "visitor", label: ws });
  }

  async unpublishFor(pubId: string, actor: PublishActor): Promise<void> {
    const j = await this.byId(pubId);
    if (!j || j.pub.status === "deleted" || j.pub.deletedAt) throw new BatonError("E_NOT_FOUND", "No such publication.");
    if (j.workspaceId !== actor.orgId) throw new BatonError("E_NOT_FOUND", "No such publication.");
    await this.deleteAgentRow(pubId, j.pub.aaiAgentId);
    await this.db.update(relays).set({ status: "draft" }).where(and(eq(relays.id, j.relayId), ne(relays.visibility, "gallery")));
    await getAuditWriter()
      .write({
        orgId: actor.orgId,
        actor: auditActorOf(actor),
        action: "relay.unpublished",
        target: { type: "publication", id: pubId },
        metadata: { relayId: j.relayId, version: j.version },
      })
      .catch((err: unknown) => pubLog.warn("audit write failed", { pubId, err }));
    pubLog.info("unpublished", { pubId, relayId: j.relayId });
  }

  // ------------------------------------------------------------------------------------------ the run lock (§8.3)

  /** Take the publication's single run slot, or refresh it for the run that already holds it. */
  async acquireRun(pubId: string, takeoverId: string): Promise<boolean> {
    const now = new Date(this.d.now());
    const until = new Date(this.d.now() + PUBLISH_LIMITS.activeLeaseMs);
    const rows = await this.db
      .update(relayPublications)
      .set({ activeRunId: takeoverId, activeUntil: until, lastUsedAt: now })
      .where(
        and(
          eq(relayPublications.id, pubId),
          eq(relayPublications.status, "live"),
          isNull(relayPublications.deletedAt),
          sql`(${relayPublications.activeRunId} is null or ${relayPublications.activeRunId} = ${takeoverId} or ${relayPublications.activeUntil} is null or ${relayPublications.activeUntil} < ${now.toISOString()}::timestamptz)`,
        ),
      )
      .returning({ id: relayPublications.id });
    return rows.length > 0;
  }

  async heartbeat(pubId: string, takeoverId: string): Promise<void> {
    const now = this.d.now();
    await this.db
      .update(relayPublications)
      .set({ activeUntil: new Date(now + PUBLISH_LIMITS.activeLeaseMs), lastUsedAt: new Date(now) })
      .where(and(eq(relayPublications.id, pubId), eq(relayPublications.activeRunId, takeoverId)));
  }

  async release(pubId: string, takeoverId: string): Promise<void> {
    await this.db
      .update(relayPublications)
      .set({ activeRunId: null, activeUntil: null, lastUsedAt: new Date(this.d.now()) })
      .where(and(eq(relayPublications.id, pubId), eq(relayPublications.activeRunId, takeoverId)));
  }

  /** The run that currently holds the slot, or null when the lease has run out. */
  activeRunOf(row: PublicationRow): string | null {
    if (!row.activeRunId) return null;
    const until = row.activeUntil ? new Date(row.activeUntil).getTime() : 0;
    return until > this.d.now() ? row.activeRunId : null;
  }

  // ------------------------------------------------------------------------------------------ purge (§8.4)

  /**
   * One purge pass: retry pending agent deletions, then unpublish publications idle past their plan's
   * `publicationIdleHours` (SAAS §4.1; pinned publications never expire).
   */
  async purge(): Promise<{ retried: number; expired: number; failed: number }> {
    let retried = 0;
    let failed = 0;
    const pending = await this.db
      .select({ id: relayPublications.id, agentId: relayPublications.aaiAgentId })
      .from(relayPublications)
      .where(and(eq(relayPublications.status, "deleting"), isNull(relayPublications.deletedAt)))
      .orderBy(asc(relayPublications.createdAt))
      .limit(25);
    for (const p of pending) {
      if (await this.deleteAgentRow(p.id, p.agentId)) retried++;
      else failed++;
    }

    let expired = 0;
    const live = await this.joinRows()
      .where(and(isNull(relayPublications.deletedAt), inArray(relayPublications.status, [...LIVE_STATUSES]), eq(relayPublications.pinned, false)))
      .orderBy(asc(relayPublications.lastUsedAt))
      .limit(50);
    for (const r of live) {
      const j = this.joinOf(r);
      const idleHours = await this.idleHoursFor(j.workspaceId);
      if (idleHours === null) continue;
      const last = (j.pub.lastUsedAt ?? j.pub.createdAt).getTime();
      if (this.d.now() - last < idleHours * 3_600_000) continue;
      if (this.activeRunOf(j.pub)) continue;
      await this.deleteAgentRow(j.pub.id, j.pub.aaiAgentId);
      await this.db.update(relays).set({ status: "draft" }).where(and(eq(relays.id, j.relayId), ne(relays.visibility, "gallery")));
      await getAuditWriter()
        .write({
          orgId: j.workspaceId,
          actor: { type: "system", id: null, label: "purge" },
          action: "relay.unpublished",
          target: { type: "publication", id: j.pub.id },
          metadata: { relayId: j.relayId, reason: "idle", idleHours },
        })
        .catch(() => undefined);
      expired++;
    }
    if (retried || expired || failed) pubLog.info("publication purge", { retried, expired, failed });
    return { retried, expired, failed };
  }

  private async idleHoursFor(orgId: string): Promise<number | null> {
    try {
      const view = await getEntitlements().get(orgId);
      return view.limits.publicationIdleHours;
    } catch {
      return PUBLISH_LIMITS.defaultIdleHours;
    }
  }
}
