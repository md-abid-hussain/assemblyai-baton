/**
 * WP18·1: the publish service over real Postgres (PLATFORM §8.1, §8.3, §8.4; SAAS §12 WP18 row).
 * TASKS-v2 §6 WP18 acceptance 2 and 6, plus the org hooks: `relay:publish`'s org, the plan's publication count and
 * lifetime, the `publish` usage record, the audit rows, and `relay_publications.org_id` once the column exists.
 * $0: the AssemblyAI REST port is a fake and moderation never leaves the process.
 */
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { BatonError } from "@/core/contracts/errors";
import { relayPublications, relays } from "@/server/db/schema";
import { isSaasError } from "@/server/saas/errors";
import {
  createMemoryAuditWriter, createMemoryUsageMeter, resetSaasPorts, setAuditWriter, setOrgCounter, setUsageMeter,
  type MemoryAuditWriter, type MemoryUsageMeter,
} from "@/server/saas/ports";
import { createAgentError, PgPublisher, PUBLISH_LIMITS } from "@/server/publish/service";
import { hashPublicationKey } from "@/server/publish/keys";
import { resetPublicationOrgColumnCache, writePublicationOrg } from "@/server/publish/org";
import { RelayError } from "@/server/relays/http";
import { ModerationUnavailableError } from "@/server/relays/moderation";
import { createTestDb, HAS_DB, type TestDb } from "../cases/helpers/test-db";
import { APP_URL, dentalBlueprint, FakeModerator, publishFixture, seedRelay, type PublishFixture } from "./helpers";

const WS = "ws_alpha";
const OTHER = "ws_beta";
const ACTOR = { orgId: WS, visitorId: "alpha", ipKey: "ip", userId: null, kind: "visitor" as const, label: "alpha" };

describe.skipIf(!HAS_DB)("PgPublisher", () => {
  let t: TestDb;
  let f: PublishFixture;
  let publisher: PgPublisher;
  let usage: MemoryUsageMeter;
  let audit: MemoryAuditWriter;

  beforeAll(async () => {
    t = await createTestDb("wp18_publish", { poolMax: 4 });
  });
  afterAll(async () => {
    await t?.drop();
  });

  beforeEach(async () => {
    await t.db.execute(sql`truncate table relay_publications, connector_calls, takeovers, cases, relay_versions, relays restart identity cascade`);
    resetSaasPorts();
    resetPublicationOrgColumnCache();
    usage = createMemoryUsageMeter();
    audit = createMemoryAuditWriter();
    setUsageMeter(usage);
    setAuditWriter(audit);
    f = publishFixture(t.db);
    publisher = new PgPublisher(f.deps);
  });

  const countLive = async (ws: string): Promise<number> => {
    const r = await t.db.execute(
      sql`select count(*)::int as n from relay_publications p join relays r on r.id = p.relay_id
          where r.workspace_id = ${ws} and p.deleted_at is null and p.status in ('creating','live')`,
    );
    return Number((r.rows[0] as { n: number }).n);
  };

  it("publishes: one stored agent, a live row, a stable share link, and no key in anything we return", async () => {
    const relay = await seedRelay(f.registry, WS);
    const r = await publisher.publishFor(relay.id, ACTOR);

    expect(f.rest.created).toHaveLength(1);
    const def = f.rest.created[0]!.def;
    expect(def.tools?.length).toBeGreaterThan(0);
    expect("greeting" in def).toBe(false);
    expect(def.input?.transcription_mode).toBe("balanced");
    const key = (def.tools![0] as { http: { headers: { value?: string }[] } }).http.headers[0]!.value!;
    expect((def.tools![0] as { http: { url: string } }).http.url.startsWith(`${APP_URL}/api/connectors/pub/${r.view.id}/`)).toBe(true);

    expect(r.view.status).toBe("live");
    expect(r.view.mode).toBe("stored_agent");
    expect(r.view.agentId).toBe(f.rest.created[0]!.id);
    expect(r.shareUrl).toBe(`/a/${r.view.shareSlug}`);
    expect(JSON.stringify(r.configRedacted)).not.toContain(key);
    expect(JSON.stringify(r.view)).not.toContain(key);

    const [row] = await t.db.select().from(relayPublications).where(eq(relayPublications.id, r.view.id));
    expect(row!.keyHash).toBe(hashPublicationKey(key));
    expect(row!.keyHash).not.toBe(key);
    const [relayRow] = await t.db.select().from(relays).where(eq(relays.id, relay.id));
    expect(relayRow!.status).toBe("published");

    // the org hooks: one `publish` usage record and one `relay.published` audit row, both on the relay's org
    expect(usage.records).toEqual([
      expect.objectContaining({ orgId: WS, kind: "publish", quantity: 1, idempotencyKey: `publish:${r.view.id}:${r.version}` }),
    ]);
    expect(audit.entries).toEqual([
      expect.objectContaining({ orgId: WS, action: "relay.published", target: { type: "publication", id: r.view.id } }),
    ]);
  });

  it("republishes: the new agent is created first, the old one is deleted, and the id, slug and share link are stable", async () => {
    const relay = await seedRelay(f.registry, WS);
    const first = await publisher.publishFor(relay.id, ACTOR);

    const bp = dentalBlueprint();
    bp.meta.title = "Dental deposit v2";
    await f.registry.saveDraft(relay.id, WS, bp, 0);
    const second = await publisher.publishFor(relay.id, ACTOR);

    expect(f.rest.created).toHaveLength(2);
    expect(f.rest.deleted).toEqual([first.view.agentId]);
    // creation of the new agent happened before the delete of the old one
    expect(f.rest.created[1]!.id).toBe(second.view.agentId);
    expect(second.view.id).toBe(first.view.id);
    expect(second.view.shareSlug).toBe(first.view.shareSlug);
    expect(second.view.version).toBeGreaterThan(first.view.version);

    // exactly one live row, plus the retired tombstone, now deleted
    expect(await countLive(WS)).toBe(1);
    const rows = await t.db.select().from(relayPublications);
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.status === "deleted")).toHaveLength(1);

    // the key rotated with the agent: the new hash matches the new agent's header, the old key no longer does
    const newKey = (f.rest.created[1]!.def.tools![0] as { http: { headers: { value?: string }[] } }).http.headers[0]!.value!;
    const [live] = await t.db.select().from(relayPublications).where(eq(relayPublications.id, second.view.id));
    expect(live!.keyHash).toBe(hashPublicationKey(newKey));
  });

  it("a failed agent delete leaves the tombstone for the purge job, which retries it", async () => {
    const relay = await seedRelay(f.registry, WS);
    const first = await publisher.publishFor(relay.id, ACTOR);
    f.rest.deleteStatus = "throw";
    const bp = dentalBlueprint();
    bp.meta.title = "Dental deposit v3";
    await f.registry.saveDraft(relay.id, WS, bp, 0);
    await publisher.publishFor(relay.id, ACTOR);

    const pending = (await t.db.select().from(relayPublications)).filter((r) => r.status === "deleting");
    expect(pending).toHaveLength(1);
    expect(pending[0]!.aaiAgentId).toBe(first.view.agentId);

    f.rest.deleteStatus = 204;
    const purged = await publisher.purge();
    expect(purged.retried).toBe(1);
    expect(f.rest.deleted).toEqual([first.view.agentId]);
    expect((await t.db.select().from(relayPublications)).filter((r) => r.status === "deleting")).toHaveLength(0);
  });

  it("unpublish deletes the agent, frees the row and puts the relay back to draft; another org cannot", async () => {
    const relay = await seedRelay(f.registry, WS);
    const r = await publisher.publishFor(relay.id, ACTOR);

    await expect(publisher.unpublishFor(r.view.id, { ...ACTOR, orgId: OTHER })).rejects.toMatchObject({ code: "E_NOT_FOUND" });
    expect(f.rest.deleted).toEqual([]);

    await publisher.unpublishFor(r.view.id, ACTOR);
    expect(f.rest.deleted).toEqual([r.view.agentId]);
    expect(await countLive(WS)).toBe(0);
    expect(await publisher.forRelay(relay.id)).toBeNull();
    const [relayRow] = await t.db.select().from(relays).where(eq(relays.id, relay.id));
    expect(relayRow!.status).toBe("draft");
    expect(audit.entries.map((e) => e.action)).toEqual(["relay.published", "relay.unpublished"]);
    await expect(publisher.unpublishFor(r.view.id, ACTOR)).rejects.toMatchObject({ code: "E_NOT_FOUND" });
  });

  it("refuses a relay with lint errors, a flagged version, and an unreachable moderation endpoint", async () => {
    const broken = dentalBlueprint();
    // C1: the greeting must disclose the AI and the recording; emptying the opening breaks it
    broken.playbook.greeting.opening = "Hello.";
    const relay = await f.registry.create(WS, { kind: "blueprint", blueprint: broken, origin: "user" });
    await expect(publisher.publishFor(relay.id, ACTOR)).rejects.toBeInstanceOf(RelayError);
    expect(f.rest.created).toHaveLength(0);

    const flagged = publishFixture(t.db, { moderator: new FakeModerator(() => true) });
    const fp = new PgPublisher(flagged.deps);
    const ok = await seedRelay(flagged.registry, WS);
    await expect(fp.publishFor(ok.id, ACTOR)).rejects.toMatchObject({ code: "E_MODERATION_FLAGGED" });
    expect(flagged.rest.created).toHaveLength(0);

    const down = publishFixture(t.db, {
      moderator: { async check() { throw new ModerationUnavailableError("down"); } },
    });
    const dp = new PgPublisher(down.deps);
    const relay3 = await seedRelay(down.registry, WS);
    await expect(dp.publishFor(relay3.id, ACTOR)).rejects.toMatchObject({ code: "E_MAINTENANCE" });
    expect(down.rest.created).toHaveLength(0);
  });

  it("enforces the plan's live-publication count on a NEW publication, but never on a republish", async () => {
    setOrgCounter("livePublications", (org) => countLive(org));
    const a = await seedRelay(f.registry, WS);
    const b = await seedRelay(f.registry, WS);
    await publisher.publishFor(a.id, ACTOR); // the guest plan allows 1

    const err = await publisher.publishFor(b.id, ACTOR).catch((e: unknown) => e);
    expect(isSaasError(err) && err.code).toBe("E_PLAN_LIMIT");
    expect(f.rest.created).toHaveLength(1);

    // the same relay again is a republish: the count does not grow, so it is allowed
    const bp = dentalBlueprint();
    bp.meta.title = "Dental deposit again";
    await f.registry.saveDraft(a.id, WS, bp, 0);
    await expect(publisher.publishFor(a.id, ACTOR)).resolves.toBeTruthy();
  });

  it("stops at the global live-agent cap, whoever is publishing", async () => {
    for (let i = 0; i < PUBLISH_LIMITS.globalLiveAgents; i++) {
      await t.db.insert(relayPublications).values({
        id: `pub_filler${i}`, relayId: `rl_filler${i}`, versionId: `rv_filler${i}`, shareSlug: `filler-${i}`,
        keyHash: "x", status: "live", aaiAgentId: `agent_filler${i}`,
      });
    }
    const relay = await seedRelay(f.registry, WS);
    const err = await publisher.publishFor(relay.id, ACTOR).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BatonError);
    expect((err as BatonError).code).toBe("E_RATE_LIMITED");
    expect(f.rest.created).toHaveLength(0);
  });

  it("refuses to publish without a public app URL (AssemblyAI could not reach the tools)", async () => {
    const local = publishFixture(t.db, { appUrl: null });
    const relay = await seedRelay(local.registry, WS);
    await expect(new PgPublisher(local.deps).publishFor(relay.id, ACTOR)).rejects.toMatchObject({ code: "E_MAINTENANCE" });
    expect(local.rest.created).toHaveLength(0);
  });

  it("tells a permanent create refusal (the 422 'host does not resolve') apart from a blip", () => {
    const rejected = Object.assign(new Error("422"), { status: 422 });
    expect(createAgentError(rejected, "https://x.test").code).toBe("E_VA_CONFIG");
    expect(createAgentError(rejected, "https://x.test").message).toContain("https://x.test");
    expect(createAgentError(Object.assign(new Error("429"), { status: 429 }), "u").code).toBe("E_VA_TRANSIENT");
    expect(createAgentError(Object.assign(new Error("503"), { status: 503 }), "u").code).toBe("E_VA_TRANSIENT");
    expect(createAgentError(new Error("socket hang up"), "u").code).toBe("E_VA_TRANSIENT");
  });

  it("a failed agent create leaves no live publication", async () => {
    const relay = await seedRelay(f.registry, WS);
    f.rest.createStatus = "fail";
    await expect(publisher.publishFor(relay.id, ACTOR)).rejects.toMatchObject({ code: "E_VA_TRANSIENT" });
    const rows = await t.db.select().from(relayPublications);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("failed");
    expect(await countLive(WS)).toBe(0);
    expect(await publisher.forRelay(relay.id)).toBeNull();
  });

  it("the single-run lock: one run at a time, refreshed by the heartbeat, freed by release and by expiry", async () => {
    const relay = await seedRelay(f.registry, WS);
    const r = await publisher.publishFor(relay.id, ACTOR);
    const pubId = r.view.id;

    expect(await publisher.acquireRun(pubId, "tko_1")).toBe(true);
    expect(await publisher.acquireRun(pubId, "tko_2")).toBe(false);
    expect(await publisher.acquireRun(pubId, "tko_1")).toBe(true); // the holder may refresh

    f.clock.now += PUBLISH_LIMITS.activeLeaseMs - 1000;
    await publisher.heartbeat(pubId, "tko_1");
    f.clock.now += PUBLISH_LIMITS.activeLeaseMs - 1000;
    expect(await publisher.acquireRun(pubId, "tko_2")).toBe(false); // the heartbeat kept the lease alive

    f.clock.now += PUBLISH_LIMITS.activeLeaseMs + 1000;
    expect(await publisher.acquireRun(pubId, "tko_2")).toBe(true); // the lease ran out

    await publisher.release(pubId, "tko_2");
    const [row] = await t.db.select().from(relayPublications).where(eq(relayPublications.id, pubId));
    expect(row!.activeRunId).toBeNull();
    expect(await publisher.acquireRun(pubId, "tko_3")).toBe(true);
  });

  it("purges idle publications on the plan's clock, never pinned ones, never a running one", async () => {
    setOrgCounter("livePublications", () => 0);
    const a = await seedRelay(f.registry, WS);
    const b = await seedRelay(f.registry, WS);
    const pubA = await publisher.publishFor(a.id, ACTOR);
    const pubB = await publisher.publishFor(b.id, ACTOR);
    await t.db.update(relayPublications).set({ pinned: true }).where(eq(relayPublications.id, pubB.view.id));

    f.clock.now += 23 * 3_600_000;
    expect((await publisher.purge()).expired).toBe(0); // the guest plan's 24 h has not passed

    f.clock.now += 2 * 3_600_000;
    await publisher.acquireRun(pubA.view.id, "tko_live"); // a run also refreshes the idle clock
    expect((await publisher.purge()).expired).toBe(0); // a run is holding it

    f.clock.now += 25 * 3_600_000; // the lease ran out long ago and nothing has used it since
    const purged = await publisher.purge();
    expect(purged.expired).toBe(1);
    expect(f.rest.deleted).toEqual([pubA.view.agentId]);
    expect(await publisher.forRelay(a.id)).toBeNull();
    expect(await publisher.forRelay(b.id)).not.toBeNull(); // pinned publications never expire
  });

  /**
   * WP19 (C3b) note on the half of this test that is gone.
   *
   * It used to also assert "…and works without it", by publishing before adding `org_id`. That half became
   * **unreachable** when `0002_saas` landed: `relayPublications` in `schema.ts` now declares `orgId`, so every
   * SELECT drizzle builds for this service names the column — `liveForRelay` fails on a table without it, long
   * before `writePublicationOrg`'s own feature check is consulted. Simulating a pre-0002 table by dropping the
   * column therefore no longer tests the old code path; it only breaks the query builder.
   *
   * Nothing is lost in production terms: `scripts/migrate.ts` runs in the Zerops `initCommands`, so a container
   * serves traffic only after 0002 has applied. `writePublicationOrg`'s column cache stays as cheap insurance and
   * is still exercised below.
   */
  it("writes relay_publications.org_id (WP19's 0002_saas column)", async () => {
    const relay = await seedRelay(f.registry, WS);
    const before = await publisher.publishFor(relay.id, ACTOR);
    expect(before.view.status).toBe("live");

    resetPublicationOrgColumnCache();
    expect(await writePublicationOrg(t.db, before.view.id, WS)).toBe(true);

    const other = await seedRelay(f.registry, WS);
    setOrgCounter("livePublications", () => 0);
    const after = await publisher.publishFor(other.id, ACTOR);
    const rows = await t.db.execute(sql`select id, org_id from relay_publications where id in (${before.view.id}, ${after.view.id})`);
    expect(rows.rows.map((r) => (r as { org_id: string }).org_id)).toEqual([WS, WS]);
  });

  it("bySlug serves the share page and hides deleted publications", async () => {
    const relay = await seedRelay(f.registry, WS);
    const r = await publisher.publishFor(relay.id, ACTOR);
    const view = await publisher.bySlug(r.view.shareSlug);
    expect(view?.id).toBe(r.view.id);
    expect(JSON.stringify(view?.configRedacted)).toContain("X-Changeover-Key");
    await publisher.unpublishFor(r.view.id, ACTOR);
    expect(await publisher.bySlug(r.view.shareSlug)).toBeNull();
  });
});
