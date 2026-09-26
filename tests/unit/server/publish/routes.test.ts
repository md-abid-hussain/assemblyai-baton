/**
 * WP18·1 at the HTTP boundary: the publish, unpublish, share-page, state and gateway handlers (TASKS-v2 §5 routes;
 * SAAS §2.5, §10.1 rule 1). Every org route goes through `requirePrincipal`, so the org acted in is the principal's
 * and a caller without `relay:publish` is refused before anything is created. Real Postgres, fake AssemblyAI, $0.
 */
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { PublicationPageViewSchema, PublishedRunStateSchema, PublishResponseSchema } from "@/core/contracts/v2";
import { DELETE as deletePublicationRoute, GET as getPublicationRoute } from "@/app/api/publications/[id]/route";
import { GET as stateRoute } from "@/app/api/publications/[id]/runs/[takeoverId]/state/route";
import { POST as pubToolRoute } from "@/app/api/connectors/pub/[pubId]/[tool]/route";
import { publishRelay } from "@/server/publish/routes";
import { setPublishDeps } from "@/server/publish/deps";
import { signVisitorId } from "@/server/auth/visitor";
import { resetSaasPorts, setOrgCounter, setPrincipalResolver } from "@/server/saas/ports";
import { setRelaysDeps } from "@/server/relays";
import { MemoryGallerySource } from "@/server/relays/seed";
import { createTestDb, HAS_DB, type TestDb } from "../cases/helpers/test-db";
import { APP_URL, FakeToolService, FakeVaRest, openLimiter, publishFixture, seedRelay, seedRun, type PublishFixture } from "./helpers";

const VISITOR_SECRET = "test-visitor-secret-0123456789abcdef";
const BASE = "http://localhost";

describe.skipIf(!HAS_DB)("WP18 routes", () => {
  let t: TestDb;
  let f: PublishFixture;
  let saved: string | undefined;
  let n = 0;

  const headersFor = (visitorId: string) => ({
    "content-type": "application/json",
    "x-baton-visitor": signVisitorId(visitorId, VISITOR_SECRET),
    "x-forwarded-for": "203.0.113.9",
  });
  const request = (method: string, path: string, visitorId: string, body?: unknown) =>
    new Request(`${BASE}${path}`, { method, headers: headersFor(visitorId), ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const ctx = <P extends Record<string, string>>(p: P) => ({ params: Promise.resolve(p) });

  beforeAll(async () => {
    saved = process.env.VISITOR_SECRET;
    process.env.VISITOR_SECRET = VISITOR_SECRET;
    t = await createTestDb("wp18_routes", { poolMax: 4 });
  });
  afterAll(async () => {
    setPublishDeps(null);
    setRelaysDeps(null);
    if (saved === undefined) delete process.env.VISITOR_SECRET;
    else process.env.VISITOR_SECRET = saved;
    await t?.drop();
  });

  beforeEach(async () => {
    await t.db.execute(sql`truncate table relay_publications, connector_calls, takeovers, cases, relay_versions, relays restart identity cascade`);
    resetSaasPorts();
    setOrgCounter("livePublications", () => 0);
    f = publishFixture(t.db);
    // the route handlers read the process graph
    setRelaysDeps({ db: t.db, gallery: new MemoryGallerySource([]), rateLimiter: () => openLimiter, now: () => f.clock.now });
    setPublishDeps({
      db: t.db,
      registry: f.deps.registry,
      engine: f.deps.engine,
      vaRest: f.deps.vaRest,
      tools: f.deps.tools,
      rateLimiter: () => openLimiter,
      now: () => f.clock.now,
      deployId: f.deps.deployId,
      appUrl: f.deps.appUrl,
    });
    n++;
  });

  const visitorId = () => `pubroutes${n}`;

  async function publish(): Promise<{ pubId: string; slug: string; key: string; versionId: string; relayId: string }> {
    const relay = await seedRelay(f.registry, `ws_${visitorId()}`);
    const res = await publishRelay(request("POST", `/api/relays/${relay.id}/publish`, visitorId()), ctx({ id: relay.id }));
    expect(res.status).toBe(201);
    const body = PublishResponseSchema.parse(await res.json());
    const rest = f.rest as FakeVaRest;
    const key = (rest.created[rest.created.length - 1]!.def.tools![0] as { http: { headers: { value?: string }[] } }).http.headers[0]!.value!;
    const versionId = rest.created.length ? body.publication.id : "";
    return { pubId: body.publication.id, slug: body.publication.shareSlug, key, versionId, relayId: relay.id };
  }

  it("POST /api/relays/:id/publish answers 201 with the share URL, the agent id and a redacted config", async () => {
    const relay = await seedRelay(f.registry, `ws_${visitorId()}`);
    const res = await publishRelay(request("POST", `/api/relays/${relay.id}/publish`, visitorId()), ctx({ id: relay.id }));
    expect(res.status).toBe(201);
    const text = await res.text();
    const body = PublishResponseSchema.parse(JSON.parse(text));
    expect(body.shareUrl).toBe(`/a/${body.publication.shareSlug}`);
    expect(body.agentId).toBe(f.rest.created[0]!.id);
    expect(JSON.stringify(body.configRedacted)).toContain("X-Changeover-Key");
    const key = (f.rest.created[0]!.def.tools![0] as { http: { headers: { value?: string }[] } }).http.headers[0]!.value!;
    expect(text).not.toContain(key);
  });

  it("refuses a principal without `relay:publish`, before anything is created", async () => {
    const relay = await seedRelay(f.registry, `ws_${visitorId()}`);
    // a viewer-shaped principal: the same device, no publish permission
    setPrincipalResolver({
      async resolve(_req, need) {
        const p = {
          kind: "session" as const, userId: "u1", isAnonymous: false, orgId: `ws_${visitorId()}`, orgKind: "team" as const,
          role: "viewer" as const, scopes: [], apiKeyId: null, plan: "free" as const, visitorId: visitorId(), ipKey: "ip", requestId: "r1",
        };
        if (need?.perm === "relay:publish") {
          const { SaasError } = await import("@/server/saas/errors");
          throw new SaasError("E_FORBIDDEN", "Your role does not allow relay:publish.");
        }
        return p;
      },
    });
    const res = await publishRelay(request("POST", `/api/relays/${relay.id}/publish`, visitorId()), ctx({ id: relay.id }));
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("E_FORBIDDEN");
    expect(f.rest.created).toHaveLength(0);
  });

  it("GET /api/publications/:slug serves the share page with the fictional banner and no mic-worthy secret", async () => {
    const p = await publish();
    const res = await getPublicationRoute(request("GET", `/api/publications/${p.slug}`, visitorId()), ctx({ id: p.slug }));
    expect(res.status).toBe(200);
    const view = PublicationPageViewSchema.parse(await res.json());
    expect(view.banner).toBe("User-made relay · fictional business");
    expect(view.publication.id).toBe(p.pubId);
    expect(view.relay.gallery).toBe(false);
    expect(view.inUse).toBe(false);
    expect(view.ui.stages.length).toBeGreaterThan(0);
    expect(JSON.stringify(view)).not.toContain(p.key);

    const gone = await getPublicationRoute(request("GET", "/api/publications/nope", visitorId()), ctx({ id: "nope" }));
    expect(gone.status).toBe(404);
  });

  it("DELETE /api/publications/:pubId unpublishes, and another visitor's device cannot", async () => {
    const p = await publish();
    const other = await deletePublicationRoute(request("DELETE", `/api/publications/${p.pubId}`, "someone-else"), ctx({ id: p.pubId }));
    expect(other.status).toBe(404);
    expect(f.rest.deleted).toEqual([]);

    const res = await deletePublicationRoute(request("DELETE", `/api/publications/${p.pubId}`, visitorId()), ctx({ id: p.pubId }));
    expect(res.status).toBe(204);
    expect(f.rest.deleted).toHaveLength(1);
  });

  it("the gateway route reads the raw args body and the key header, exactly as AssemblyAI sends them", async () => {
    const p = await publish();
    const pub = (await import("@/server/publish/service")).PgPublisher;
    const publisher = new pub(f.deps);
    const versionId = (await publisher.byId(p.pubId))!.versionId;
    const run = await seedRun(t.db, { visitorId: visitorId(), relayVersionId: versionId, stage: "pay" });
    await publisher.acquireRun(p.pubId, run.takeoverId);
    (f.tools as FakeToolService).next = { result: { status: "link_sent" }, stage: "close", nextStep: "Close warmly." };

    const call = (key: string | null) =>
      pubToolRoute(
        new Request(`${APP_URL}/api/connectors/pub/${p.pubId}/send_deposit_link`, {
          method: "POST",
          headers: { "content-type": "application/json", ...(key ? { "X-Changeover-Key": key } : {}) },
          body: JSON.stringify({ patient_name: "Jordan Lee", amount_usd: 25 }),
        }),
        ctx({ pubId: p.pubId, tool: "send_deposit_link" }),
      );

    const bad = await call("f".repeat(64));
    expect(bad.status).toBe(401);
    const ok = await call(p.key);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ status: "link_sent", next_step: "Close warmly." });

    // the state route then reports the event to the run's own device
    const st = await stateRoute(request("GET", `/api/publications/${p.pubId}/runs/${run.takeoverId}/state?after=0`, visitorId()), ctx({ id: p.pubId, takeoverId: run.takeoverId }));
    expect(st.status).toBe(200);
    const state = PublishedRunStateSchema.parse(await st.json());
    expect(state.events.map((e) => e.tool)).toEqual(["send_deposit_link"]);
    expect(state.cursor).toBe(1);
    expect(state.nextStep).toBe("Close warmly.");

    const foreign = await stateRoute(request("GET", `/api/publications/${p.pubId}/runs/${run.takeoverId}/state`, "another-visitor"), ctx({ id: p.pubId, takeoverId: run.takeoverId }));
    expect(foreign.status).toBe(403);
  });
});
