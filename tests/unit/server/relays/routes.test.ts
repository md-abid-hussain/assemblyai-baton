/**
 * `/api/relays/**` end to end (TASKS-v2 WP14b acceptance 2 and 3): handlers called directly, real Postgres, WP12's
 * visitor auth and DB rate limiter, the stub gallery, $0.
 */
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ApiErrorV2Schema, CreateVersionResponseSchema, ListRelaysResponseSchema, RelayDetailSchema, SaveDraftResponseSchema, type RelayDetail } from "@/core/contracts/v2";
import { POST as versionsRoute } from "@/app/api/relays/[id]/versions/route";
import { PUT as draftRoute } from "@/app/api/relays/[id]/draft/route";
import { GET as compiledRoute } from "@/app/api/relays/[id]/compiled/route";
import { DELETE as deleteRoute, GET as getRoute, PUT as putRoute } from "@/app/api/relays/[id]/route";
import { GET as listRoute, POST as createRoute } from "@/app/api/relays/route";
import { signVisitorId } from "@/server/auth/visitor";
import { setKernelBinding } from "@/server/engine/kernel-binding";
import { rateEvents } from "@/server/db/schema";
import { DbRateLimiter } from "@/server/limits/rate-limiter";
import { MemoryGallerySource, setRelaysDeps } from "@/server/relays";
import { RELAY_RATES } from "@/server/relays/quotas";
import { createTestDb, HAS_DB, type TestDb } from "../cases/helpers/test-db";
import { ctxOf, galleryEntries, req, scalar, SECRETS, withSecrets } from "./helpers";

describe.skipIf(!HAS_DB)("/api/relays routes", () => {
  let t: TestDb;
  let restore: () => void;
  let limiter: DbRateLimiter;
  let n = 0;

  beforeAll(async () => {
    restore = withSecrets();
    t = await createTestDb("wp14b_routes", { poolMax: 4 });
    limiter = new DbRateLimiter(t.db);
    setRelaysDeps({ db: t.db, gallery: new MemoryGallerySource(galleryEntries()), rateLimiter: () => limiter });
  });
  afterAll(async () => {
    setRelaysDeps(null);
    restore?.();
    await t?.drop();
  });

  /** A fresh visitor: its signed `x-baton-visitor` header and its own network. */
  function visitor() {
    n++;
    const id = `visitor${n}_${Math.random().toString(36).slice(2, 8)}`;
    return { id, h: { "x-baton-visitor": signVisitorId(id, SECRETS.VISITOR_SECRET), "x-forwarded-for": `198.51.100.${n}` } };
  }
  const list = async (h: Record<string, string>) => ListRelaysResponseSchema.parse(await (await listRoute(req("GET", "/api/relays", undefined, h), ctxOf("") as never)).json());
  const create = (h: Record<string, string>, body: unknown) => createRoute(req("POST", "/api/relays", body, h), ctxOf("") as never);
  const get = (h: Record<string, string>, id: string) => getRoute(req("GET", `/api/relays/${id}`, undefined, h), ctxOf(id));
  const saveDraft = (h: Record<string, string>, id: string, body: unknown) => draftRoute(req("PUT", `/api/relays/${id}/draft`, body, h), ctxOf(id));
  const snapshot = (h: Record<string, string>, id: string) => versionsRoute(req("POST", `/api/relays/${id}/versions`, {}, h), ctxOf(id));
  const errCode = async (r: Response) => ApiErrorV2Schema.parse(await r.json()).error.code;
  async function cloneDental(h: Record<string, string>): Promise<RelayDetail> {
    const g = await list(h);
    const r = await create(h, { kind: "clone", relayId: g.gallery.find((x) => x.slug === "dental-deposit")!.id });
    expect(r.status).toBe(201);
    return RelayDetailSchema.parse(await r.json());
  }

  it("GET /api/relays seeds the gallery once and lists gallery + mine", async () => {
    const v = visitor();
    const l = await list(v.h);
    expect(l.gallery.map((g) => g.slug)).toEqual(["baton-add-driver", "dental-deposit"]);
    expect(l.mine).toEqual([]);
    const c = await scalar(t.db, sql`select count(*)::int as c from relay_versions`);
    await list(visitor().h);
    const c2 = await scalar(t.db, sql`select count(*)::int as c from relay_versions`);
    expect(c2).toBe(c);
  });

  it("gallery relays are read-only (403 E_READ_ONLY) but expose their preset versions", async () => {
    const v = visitor();
    const g = (await list(v.h)).gallery.find((x) => x.slug === "dental-deposit")!;
    const d = RelayDetailSchema.parse(await (await get(v.h, g.slug)).json());
    expect(d.readOnly).toBe(true);
    expect(d.presets.map((p) => p.id)).toEqual(["deposit_75", "add_insurer"]);
    expect(d.presets.every((p) => p.versionId.startsWith("rv_"))).toBe(true);
    const put = await saveDraft(v.h, g.id, { blueprint: d.draft, expectedRev: d.draftRev });
    expect(put.status).toBe(403);
    expect(await errCode(put)).toBe("E_READ_ONLY");
    const vis = await putRoute(req("PUT", `/api/relays/${g.id}`, { visibility: "unlisted" }, v.h), ctxOf(g.id));
    expect(vis.status).toBe(403);
    expect((await deleteRoute(req("DELETE", `/api/relays/${g.id}`, undefined, v.h), ctxOf(g.id))).status).toBe(403);
    expect((await snapshot(v.h, g.id)).status).toBe(403);
    // "Keep editing" on a preset clones exactly that version
    const kept = await create(v.h, { kind: "clone", relayId: d.presets[1]!.versionId });
    expect(kept.status).toBe(201);
    expect(RelayDetailSchema.parse(await kept.json()).draft.fields.map((f) => f.id)).toContain("insurer");
  });

  it("clone → own draft; rev conflict → 409 {conflict, rev}; schema failure → 422 E_LINT with issues", async () => {
    const v = visitor();
    const c = await cloneDental(v.h);
    expect(c).toMatchObject({ origin: "clone", readOnly: false, draftRev: 0 });
    const bp = structuredClone(c.draft);
    bp.meta.title = "Brightwater front desk";
    const ok = await saveDraft(v.h, c.id, { blueprint: bp, expectedRev: 0 });
    expect(ok.status).toBe(200);
    expect(SaveDraftResponseSchema.parse(await ok.json())).toEqual({ rev: 1, lint: [] });
    const stale = await saveDraft(v.h, c.id, { blueprint: bp, expectedRev: 0 });
    expect(stale.status).toBe(409);
    const body = (await stale.json()) as { conflict: boolean; rev: number; error: { code: string } };
    expect(SaveDraftResponseSchema.parse(body)).toEqual({ conflict: true, rev: 1 });
    expect(body.error.code).toBe("E_DRAFT_CONFLICT");
    const bad = await saveDraft(v.h, c.id, { blueprint: { ...bp, fields: [] }, expectedRev: 1 });
    expect(bad.status).toBe(422);
    const e = ApiErrorV2Schema.parse(await bad.json());
    expect(e.error.code).toBe("E_LINT");
    expect(e.error.lint?.[0]).toMatchObject({ code: "SCHEMA", path: ["fields"] });
    const malformed = await saveDraft(v.h, c.id, { expectedRev: "x" });
    expect(malformed.status).toBe(400);
    const d = RelayDetailSchema.parse(await (await get(v.h, c.id)).json());
    expect(d).toMatchObject({ title: "Brightwater front desk", draftRev: 1 });
  });

  it("POST /versions is idempotent by hash: 201 created, then 200 with the same version", async () => {
    const v = visitor();
    const c = await cloneDental(v.h);
    const a = await snapshot(v.h, c.id);
    expect(a.status).toBe(201);
    const s1 = CreateVersionResponseSchema.parse(await a.json());
    expect(s1).toMatchObject({ version: 1, created: true });
    const b = await snapshot(v.h, c.slug);
    expect(b.status).toBe(200);
    expect(CreateVersionResponseSchema.parse(await b.json())).toEqual({ ...s1, created: false });
    expect(RelayDetailSchema.parse(await (await get(v.h, c.id)).json())).toMatchObject({ currentVersionId: s1.versionId, versionCount: 1 });
  });

  it("workspace isolation: another visitor gets 404 on a private relay (by id or slug); unlisted is read-only", async () => {
    const a = visitor();
    const b = visitor();
    const c = await cloneDental(a.h);
    expect((await get(b.h, c.id)).status).toBe(404);
    expect((await get(b.h, c.slug)).status).toBe(404);
    expect((await saveDraft(b.h, c.id, { blueprint: c.draft, expectedRev: 0 })).status).toBe(404);
    expect((await snapshot(b.h, c.id)).status).toBe(404);
    expect((await deleteRoute(req("DELETE", `/api/relays/${c.id}`, undefined, b.h), ctxOf(c.id))).status).toBe(404);
    expect((await list(b.h)).mine).toEqual([]);
    expect((await list(a.h)).mine.map((m) => m.id)).toEqual([c.id]);
    // no identity at all → a fresh workspace, never someone else's
    expect((await getRoute(req("GET", `/api/relays/${c.id}`), ctxOf(c.id))).status).toBe(404);
    const vis = await putRoute(req("PUT", `/api/relays/${c.id}`, { visibility: "unlisted" }, a.h), ctxOf(c.id));
    expect(vis.status).toBe(200);
    expect(RelayDetailSchema.parse(await (await get(b.h, c.slug)).json())).toMatchObject({ readOnly: true, visibility: "unlisted" });
    expect((await saveDraft(b.h, c.id, { blueprint: c.draft, expectedRev: 0 })).status).toBe(403);
    const del = await deleteRoute(req("DELETE", `/api/relays/${c.id}`, undefined, a.h), ctxOf(c.id));
    expect(del.status).toBe(204);
    expect((await get(a.h, c.id)).status).toBe(404);
  });

  it("quota 429s never block a $0 action: past 5 live relays a blank create is 429, but gallery clones, saves, snapshots and reads still work", async () => {
    const v = visitor();
    for (let i = 0; i < 5; i++) expect((await create(v.h, { kind: "blank", industry: "other" })).status).toBe(201);
    const sixth = await create(v.h, { kind: "blank", industry: "other" });
    expect(sixth.status).toBe(429);
    const e = ApiErrorV2Schema.parse(await sixth.json());
    expect(e.error).toMatchObject({ code: "E_RATE_LIMITED", message: "You have 5 relays; delete one to add another." });
    // exhaust every paid bucket for this visitor too: none of them gates a Studio action
    for (const bucket of ["run", "draft", "sim:dryrun", "sim:generate", "greeting:hear", "publish", "pub:run", "conn:test"]) {
      await t.db.insert(rateEvents).values({ bucket, key: v.id, cost: 1000 });
    }
    const c = await cloneDental(v.h); // gallery clone: exempt
    expect((await saveDraft(v.h, c.id, { blueprint: c.draft, expectedRev: 0 })).status).toBe(200);
    expect((await snapshot(v.h, c.id)).status).toBe(201);
    expect((await get(v.h, c.id)).status).toBe(200);
    expect((await list(v.h)).mine).toHaveLength(6);
    // relay:save is its own bucket (120/h): only exhausting IT refuses a save, with Retry-After
    await t.db.insert(rateEvents).values({ bucket: RELAY_RATES.saveVisitor.bucket, key: v.id, cost: RELAY_RATES.saveVisitor.limit });
    const refused = await saveDraft(v.h, c.id, { blueprint: c.draft, expectedRev: 1 });
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await get(v.h, c.id)).status).toBe(200);
  });

  it("the daily create bucket refuses the 11th non-clone create of the day (after deletes), per visitor", async () => {
    const v = visitor();
    await t.db.insert(rateEvents).values({ bucket: RELAY_RATES.createVisitor.bucket, key: v.id, cost: RELAY_RATES.createVisitor.limit });
    const r = await create(v.h, { kind: "blank", industry: "other" });
    expect(r.status).toBe(429);
    expect(r.headers.get("retry-after")).not.toBeNull();
    expect((await cloneDental(v.h)).origin).toBe("clone");
  });

  it("clone still works when the global cap is reached: an idle relay is archived instead", async () => {
    let clock = Date.now();
    setRelaysDeps({
      db: t.db, gallery: new MemoryGallerySource(galleryEntries()), rateLimiter: () => limiter,
      now: () => clock, caps: { softLive: 1, hardLive: 10_000, idleMs: 3_600_000 },
    });
    try {
      const live = await scalar(t.db, sql`select count(*)::int as live from relays where deleted_at is null and status <> 'archived' and visibility <> 'gallery'`);
      expect(live).toBeGreaterThan(1);
      clock += 2 * 3_600_000; // everything is idle now
      const v = visitor();
      const c = await cloneDental(v.h);
      expect(c.origin).toBe("clone");
      const archived = await scalar(t.db, sql`select count(*)::int as archived from relays where status = 'archived'`);
      expect(archived).toBe(live); // live + 1 - softLive(1)
      expect((await list(v.h)).mine.map((m) => m.id)).toEqual([c.id]);
    } finally {
      setRelaysDeps({ db: t.db, gallery: new MemoryGallerySource(galleryEntries()), rateLimiter: () => limiter });
    }
  });

  it("GET /compiled: 404 across workspaces, 503 E_MAINTENANCE with no kernel bound, 200 with the real one, then the injected view", async () => {
    const v = visitor();
    const c = await cloneDental(v.h);
    expect((await compiledRoute(req("GET", `/api/relays/${c.id}/compiled`, undefined, visitor().h), ctxOf(c.id))).status).toBe(404);
    // The kernel is bound by default since G2-finish, so the E_MAINTENANCE path is exercised by unbinding it.
    setKernelBinding(null);
    try {
      const r = await compiledRoute(req("GET", `/api/relays/${c.id}/compiled`, undefined, v.h), ctxOf(c.id));
      expect(r.status).toBe(503);
      expect(await errCode(r)).toBe("E_MAINTENANCE");
    } finally {
      setKernelBinding(undefined);
    }
    // With the real kernel bound (the default), the route compiles for real - no injected view.
    expect((await compiledRoute(req("GET", `/api/relays/${c.id}/compiled`, undefined, v.h), ctxOf(c.id))).status).toBe(200);
    const seen: { versionId: string | null; title: string }[] = [];
    setRelaysDeps({
      db: t.db, gallery: new MemoryGallerySource(galleryEntries()), rateLimiter: () => limiter,
      compileView: async (i) => {
        seen.push({ versionId: i.versionId, title: i.blueprint.meta.title });
        return { relayId: i.relayId } as never;
      },
    });
    try {
      const s = CreateVersionResponseSchema.parse(await (await snapshot(v.h, c.id)).json());
      expect((await compiledRoute(req("GET", `/api/relays/${c.id}/compiled?version=${s.versionId}`, undefined, v.h), ctxOf(c.id))).status).toBe(200);
      expect((await compiledRoute(req("GET", `/api/relays/${c.id}/compiled`, undefined, v.h), ctxOf(c.id))).status).toBe(200);
      expect(seen).toEqual([{ versionId: s.versionId, title: "Dental deposit" }, { versionId: null, title: "Dental deposit" }]);
      const g = (await list(v.h)).gallery[1]!;
      const other = await compiledRoute(req("GET", `/api/relays/${c.id}/compiled?version=${(await (await get(v.h, g.id)).json() as RelayDetail).currentVersionId}`, undefined, v.h), ctxOf(c.id));
      expect(other.status).toBe(404); // a version of another relay
    } finally {
      setRelaysDeps({ db: t.db, gallery: new MemoryGallerySource(galleryEntries()), rateLimiter: () => limiter });
    }
  });

  it("POST /api/relays validates the body (400) and a bad blueprint (422 E_LINT)", async () => {
    const v = visitor();
    expect((await create(v.h, { kind: "nope" })).status).toBe(400);
    expect((await create(v.h, "{not json")).status).toBe(400);
    const bad = await create(v.h, { kind: "blueprint", origin: "user", blueprint: { meta: { schema: "x" } } });
    expect(bad.status).toBe(422);
    expect(await errCode(bad)).toBe("E_LINT");
  });
});
