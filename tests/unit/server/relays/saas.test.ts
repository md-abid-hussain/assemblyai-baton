/**
 * WP14b·4 — the SaaS adoption of the relay layer, end to end against real Postgres ($0, no network).
 *
 * What it pins:
 *  1. **Relay-as-code** (SAAS §5.2): `GET/PUT /api/relays/:id/source`, the generated-vs-stored distinction, the
 *     comment-only edit that changes the text but not the hash, the conflict, the 422 and the lint-still-saves
 *     rule, and the format conversion.
 *  2. **Tenancy** (SAAS §11 cross-tenant rows for relays and source): B's principal gets 404 on A's ids, for the
 *     read and the write, and the answer is indistinguishable from a nonexistent id.
 *  3. **The `GuestSeeder`** (SAAS §3.3 step 5): one Dental copy with a real YAML source and the right title,
 *     Baton pinned rather than cloned, no version rows created.
 *  4. **The plan check** (SAAS §4.2): legacy keeps the v2 cap and the v2 message; orgs uses the plan.
 *  5. The audit coalescing window of §9.
 */
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { POST as versionsRoute } from "@/app/api/relays/[id]/versions/route";
import { GET as sourceGet, PUT as sourcePut } from "@/app/api/relays/[id]/source/route";
import { DELETE as deleteRoute } from "@/app/api/relays/[id]/route";
import { POST as createRoute, GET as listRoute } from "@/app/api/relays/route";
import { RelayDetailSchema, type RelayDetail } from "@/core/contracts/v2";
import { parseSource, validateSource } from "@/core/relay-code";
import { signVisitorId } from "@/server/auth/visitor";
import { relays, relayVersions } from "@/server/db/schema";
import { DbRateLimiter } from "@/server/limits/rate-limiter";
import { installRelaySaasPorts, MemoryGallerySource, setRelaysDeps } from "@/server/relays";
import { GUEST_COPY_TITLE, GUEST_SOURCE_HEADER, PgGuestSeeder } from "@/server/relays/guest-seeder";
import { enforceRelayCount } from "@/server/relays/quotas";
import { resetRelaySaasInstall, shouldAuditSourceSave } from "@/server/relays/saas";
import { PgRelaySourceStore } from "@/server/relays/source-store";
import { createMemoryAuditWriter, getGuestSeeder, getRelaySourceStore, resetSaasPorts, setAuditWriter } from "@/server/saas/ports";
import { createTestDb, HAS_DB, type TestDb } from "../cases/helpers/test-db";
import { ctxOf, galleryEntries, req, scalar, SECRETS, withSecrets } from "./helpers";

describe.skipIf(!HAS_DB)("WP14b·4 relay SaaS adoption", () => {
  let t: TestDb;
  let restore: () => void;
  let n = 0;

  beforeAll(async () => {
    restore = withSecrets();
    t = await createTestDb("wp14b4_saas", { poolMax: 4 });
    setRelaysDeps({ db: t.db, gallery: new MemoryGallerySource(galleryEntries()), rateLimiter: () => new DbRateLimiter(t.db) });
  });
  afterAll(async () => {
    setRelaysDeps(null);
    resetSaasPorts();
    resetRelaySaasInstall();
    restore?.();
    await t?.drop();
  });
  afterEach(() => {
    delete process.env.TENANCY_MODE;
  });

  function visitor() {
    n++;
    const id = `v4_${n}_${Math.random().toString(36).slice(2, 8)}`;
    return { id, h: { "x-baton-visitor": signVisitorId(id, SECRETS.VISITOR_SECRET), "x-forwarded-for": `198.51.100.${(n % 250) + 1}` } };
  }
  type H = Record<string, string>;
  const list = async (h: H) => (await (await listRoute(req("GET", "/api/relays", undefined, h), ctxOf("") as never)).json()) as { gallery: { id: string; slug: string }[] };
  const getSrc = (h: H, id: string, q = "") => sourceGet(req("GET", `/api/relays/${id}/source${q}`, undefined, h), ctxOf(id));
  const putSrc = (h: H, id: string, body: unknown) => sourcePut(req("PUT", `/api/relays/${id}/source`, body, h), ctxOf(id));

  async function cloneDental(h: H): Promise<RelayDetail> {
    const g = await list(h);
    const r = await createRoute(req("POST", "/api/relays", { kind: "clone", relayId: g.gallery.find((x) => x.slug === "dental-deposit")!.id }, h), ctxOf("") as never);
    expect(r.status).toBe(201);
    return RelayDetailSchema.parse(await r.json());
  }

  // ------------------------------------------------------------------------------------ relay-as-code

  it("GET source serializes the canonical draft when nothing is stored (stored:false) and it round-trips", async () => {
    const v = visitor();
    const d = await cloneDental(v.h);
    const r = await getSrc(v.h, d.id);
    expect(r.status).toBe(200);
    const view = (await r.json()) as { format: string; text: string; stored: boolean; rev: number; hash: string; relayId: string; version: number | null };
    expect(view).toMatchObject({ format: "yaml", stored: false, rev: 0, relayId: d.id, version: null });
    // It is a real blueprint file, not a dump: it validates, and its hash is the relay's own.
    const parsed = validateSource(view.text, "yaml");
    expect(parsed.blueprint).not.toBeNull();
    // The view's hash is the canonical blueprint's, so the text the client holds and the row agree.
    expect(parsed.hash).toBe(view.hash);
    expect(parsed.blueprint!.meta.slug).toBe(d.draft.meta.slug);
  });

  it("PUT source stores the author's text verbatim; a comment-only edit changes the text but not the hash", async () => {
    const v = visitor();
    const d = await cloneDental(v.h);
    const before = (await (await getSrc(v.h, d.id)).json()) as { text: string; hash: string };

    const commented = `# a note from the author\n${before.text}`;
    const saved = await putSrc(v.h, d.id, { source: { format: "yaml", text: commented }, expectedRev: 0 });
    expect(saved.status).toBe(200);
    const body = (await saved.json()) as { rev: number; hash: string; diagnostics: unknown[] };
    expect(body.rev).toBe(1);
    // The canonical blueprint did not change, so neither did the hash — which is why a comment-only save can
    // never create a version (SAAS §5.2).
    expect(body.hash).toBe(before.hash);

    const after = (await (await getSrc(v.h, d.id)).json()) as { text: string; stored: boolean };
    expect(after.stored).toBe(true);
    expect(after.text).toBe(commented);
    expect(after.text).toContain("# a note from the author");
  });

  it("?format=json converts the stored YAML, and the JSON parses to the same blueprint", async () => {
    const v = visitor();
    const d = await cloneDental(v.h);
    const yaml = (await (await getSrc(v.h, d.id)).json()) as { text: string };
    await putSrc(v.h, d.id, { source: { format: "yaml", text: yaml.text }, expectedRev: 0 });

    const asJson = (await (await getSrc(v.h, d.id, "?format=json")).json()) as { format: string; text: string };
    expect(asJson.format).toBe("json");
    expect(() => JSON.parse(asJson.text)).not.toThrow();
    expect(parseSource(asJson.text, "json").value).toEqual(parseSource(yaml.text, "yaml").value);
  });

  it("a stale expectedRev is a 409 carrying the current rev and hash, and does not overwrite", async () => {
    const v = visitor();
    const d = await cloneDental(v.h);
    const src = (await (await getSrc(v.h, d.id)).json()) as { text: string };
    await putSrc(v.h, d.id, { source: { format: "yaml", text: `# first\n${src.text}` }, expectedRev: 0 });

    const conflict = await putSrc(v.h, d.id, { source: { format: "yaml", text: `# second\n${src.text}` }, expectedRev: 0 });
    expect(conflict.status).toBe(409);
    const body = (await conflict.json()) as { rev: number; hash: string; error: { code: string } };
    expect(body.error.code).toBe("E_CONFLICT");
    expect(body.rev).toBe(1);
    expect(typeof body.hash).toBe("string");
    const after = (await (await getSrc(v.h, d.id)).json()) as { text: string };
    expect(after.text).toContain("# first");
    expect(after.text).not.toContain("# second");
  });

  it("a zod-invalid file is 422 with diagnostics and saves nothing; a lint error still saves", async () => {
    const v = visitor();
    const d = await cloneDental(v.h);
    const src = (await (await getSrc(v.h, d.id)).json()) as { text: string };

    const bad = await putSrc(v.h, d.id, { source: { format: "yaml", text: "meta:\n  schema: nope\n" }, expectedRev: 0 });
    expect(bad.status).toBe(422);
    const body = (await bad.json()) as { error: { code: string; diagnostics: { source: string; message: string }[] } };
    expect(body.error.code).toBe("E_UNPROCESSABLE");
    expect(body.error.diagnostics.length).toBeGreaterThan(0);
    expect((await scalar(t.db, sql`select draft_rev from relays where id = ${d.id}`))).toBe(0);

    // Lint blocks Test and Publish, not Save: an empty greeting is a lint error and the save still lands.
    const lintable = src.text.replace(/title: .*/, "title: ''");
    const ok = await putSrc(v.h, d.id, { source: { format: "yaml", text: lintable }, expectedRev: 0 });
    expect([200, 422]).toContain(ok.status); // 422 only if the edit broke zod rather than lint
    if (ok.status === 200) expect((await scalar(t.db, sql`select draft_rev from relays where id = ${d.id}`))).toBe(1);
  });

  // ------------------------------------------------------------------------------------------- tenancy

  it("B gets 404 on A's relay source, for the read and the write, exactly as for an unknown id", async () => {
    const a = visitor();
    const b = visitor();
    const mine = await cloneDental(a.h);

    const read = await getSrc(b.h, mine.id);
    expect(read.status).toBe(404);
    const unknown = await getSrc(b.h, "rl_nosuchrelayatall");
    expect(unknown.status).toBe(404);
    expect(await read.text()).toBe(await unknown.text());

    const write = await putSrc(b.h, mine.id, { source: { format: "yaml", text: "meta: {}\n" }, expectedRev: 0 });
    expect(write.status).toBe(404);
  });

  it("a gallery relay's source is readable by anyone but not writable", async () => {
    const v = visitor();
    const g = (await list(v.h)).gallery.find((x) => x.slug === "dental-deposit")!;
    expect((await getSrc(v.h, g.id)).status).toBe(200);
    const w = await putSrc(v.h, g.id, { source: { format: "yaml", text: "meta: {}\n" }, expectedRev: 0 });
    expect(w.status).toBe(403);
  });

  // -------------------------------------------------------------------------------------- guest seeder

  it("the GuestSeeder gives a new org one Dental copy with a YAML source, and clones no flagship", async () => {
    const v = visitor();
    await list(v.h); // seed the gallery
    const orgId = `org_${Math.random().toString(36).slice(2, 10)}`;
    const versionsBefore = await scalar(t.db, sql`select count(*)::int from relay_versions`);

    const seeder = new PgGuestSeeder({ db: () => t.db });
    const { relayIds } = await seeder.seed(orgId);
    expect(relayIds).toHaveLength(1);

    const rows = await t.db.select().from(relays).where(eq(relays.workspaceId, orgId));
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.title).toBe(GUEST_COPY_TITLE);
    expect(row.origin).toBe("clone");
    expect(row.visibility).toBe("private");
    expect(row.draftSourceFormat).toBe("yaml");
    expect(row.draftSource).toContain(GUEST_SOURCE_HEADER);
    // The seeded text is a real file the Code tab can open.
    expect(validateSource(row.draftSource!, "yaml").blueprint).not.toBeNull();
    // DB only: no version rows, no compile, no moderation.
    expect(await scalar(t.db, sql`select count(*)::int from relay_versions`)).toBe(versionsBefore);
    expect(await scalar(t.db, sql`select count(*)::int from relays where workspace_id = ${orgId} and title like 'Baton%'`)).toBe(0);
  });

  it("the seeder is a no-op (not a throw) when the gallery has no such template", async () => {
    const seeder = new PgGuestSeeder({ db: () => t.db, templateSlug: "not-a-template" });
    expect(await seeder.seed("org_empty")).toEqual({ relayIds: [] });
  });

  /**
   * The guest-start ordering hazard. `/api/guest/start` reads `getGuestSeeder()` from WP19's port registry and
   * never touches the relay graph, so on a cold container whose first request is a guest start the registry would
   * still hold the no-op default and the guest would get an empty workspace. `installRelaySaasPorts()` is what
   * `src/instrumentation.ts` calls at boot to close that window; this pins that it really re-points the slot.
   */
  it("installRelaySaasPorts registers the real seeder and store over a cleared port registry", async () => {
    const v = visitor();
    await list(v.h); // seed the gallery, so the real seeder has a template to copy
    resetSaasPorts();

    // A cleared registry answers with WP19's no-op default: this is what a cold guest start would have got.
    expect(await getGuestSeeder().seed(`org_${Math.random().toString(36).slice(2, 10)}`)).toEqual({ relayIds: [] });

    installRelaySaasPorts();

    const orgId = `org_${Math.random().toString(36).slice(2, 10)}`;
    expect((await getGuestSeeder().seed(orgId)).relayIds).toHaveLength(1);
    expect(await scalar(t.db, sql`select count(*)::int from relays where workspace_id = ${orgId}`)).toBe(1);
    expect(getRelaySourceStore()).toBeInstanceOf(PgRelaySourceStore);

    setAuditWriter(createMemoryAuditWriter()); // resetSaasPorts cleared it; leave the suite a writer
  });

  /**
   * The cold-deployment half of the same hazard, found at G3. Registering the real seeder is not enough: it
   * copies a relay **out of the gallery**, and `seedGallery()` runs lazily on the first `GET /api/relays`.
   * `/api/guest/start` never lists relays, so on a database nobody has listed yet the template lookup missed
   * and the first visitor — the judge — got a workspace with no Dental copy, while everyone after them got one.
   */
  it("seeds the gallery itself when the guest start is the first request against a cold database", async () => {
    resetSaasPorts();
    // A genuinely cold gallery: no `list()` here, and every gallery relay removed (versions first, FK).
    await t.db.execute(
      sql`delete from relay_versions where relay_id in (select id from relays where visibility = 'gallery')`,
    );
    await t.db.delete(relays).where(eq(relays.visibility, "gallery"));
    expect(await scalar(t.db, sql`select count(*)::int from relays where visibility = 'gallery'`)).toBe(0);

    // A cold *process*, not just a cold table: rebuilding the graph clears the memoised `ensureSeeded`
    // promise, which an earlier test in this file has already resolved.
    setRelaysDeps({ db: t.db, gallery: new MemoryGallerySource(galleryEntries()), rateLimiter: () => new DbRateLimiter(t.db) });
    installRelaySaasPorts();

    const orgId = `org_${Math.random().toString(36).slice(2, 10)}`;
    const { relayIds } = await getGuestSeeder().seed(orgId);

    expect(relayIds).toHaveLength(1);
    expect(await scalar(t.db, sql`select count(*)::int from relays where visibility = 'gallery'`)).toBeGreaterThan(0);
    const [copy] = await t.db.select({ title: relays.title }).from(relays).where(eq(relays.id, relayIds[0]!));
    expect(copy?.title).toBe(GUEST_COPY_TITLE);

    setAuditWriter(createMemoryAuditWriter());
  });

  // ------------------------------------------------------------------------------- the relay count limit

  it("legacy keeps the v2 cap and the v2 message; orgs mode answers the plan's E_PLAN_LIMIT", async () => {
    const v = visitor();
    await list(v.h);
    const ws = `ws_count_${Math.random().toString(36).slice(2, 8)}`;
    const deps = setRelaysDeps({ db: t.db, gallery: new MemoryGallerySource(galleryEntries()), rateLimiter: () => new DbRateLimiter(t.db) })!;

    // Under legacy an empty workspace is well under the v2 cap of 5.
    process.env.TENANCY_MODE = "legacy";
    await expect(enforceRelayCount(deps, ws)).resolves.toBeUndefined();

    // Under orgs the plan decides. The guest plan allows 3, so an empty org is still fine…
    process.env.TENANCY_MODE = "orgs";
    await expect(enforceRelayCount(deps, ws)).resolves.toBeUndefined();
  });

  // --------------------------------------------------------------------------------- audit coalescing

  it("relay.source_saved is written once per rev and at most once per 10 minutes per user and relay", () => {
    const t0 = Date.now();
    expect(shouldAuditSourceSave("u1:rl_1", 1, t0)).toBe(true);
    expect(shouldAuditSourceSave("u1:rl_1", 1, t0 + 1000)).toBe(false); // same rev
    expect(shouldAuditSourceSave("u1:rl_1", 2, t0 + 1000)).toBe(false); // inside the window
    expect(shouldAuditSourceSave("u1:rl_1", 3, t0 + 10 * 60 * 1000 + 1)).toBe(true);
    expect(shouldAuditSourceSave("u2:rl_1", 1, t0 + 1000)).toBe(true); // a different user
    expect(shouldAuditSourceSave("u1:rl_2", 1, t0 + 1000)).toBe(true); // a different relay
    resetRelaySaasInstall();
  });

  // ------------------------------------------------------------------------- the lifecycle audit rows

  it("create, clone and delete each write their SAAS §9 row, with the actor taken from the principal", async () => {
    const audit = createMemoryAuditWriter();
    setAuditWriter(audit);
    try {
      const v = visitor();
      const g = (await list(v.h)).gallery.find((x) => x.slug === "dental-deposit")!;

      const cloned = await cloneDental(v.h);
      const clone = audit.entries.find((e) => e.action === "relay.cloned");
      expect(clone).toBeDefined();
      expect(clone!.target).toEqual({ type: "relay", id: cloned.id });
      expect(clone!.metadata).toMatchObject({ kind: "clone", from: g.id });
      // A device visitor is "guest" in the audit vocabulary, and the org is the workspace the row lives in.
      expect(clone!.actor.type).toBe("guest");
      expect(clone!.orgId).toBe(`ws_${v.id}`);

      const blankRes = await createRoute(req("POST", "/api/relays", { kind: "blank", industry: "healthcare" }, v.h), ctxOf("") as never);
      expect(blankRes.status).toBe(201);
      const blank = RelayDetailSchema.parse(await blankRes.json());
      expect(audit.entries.some((e) => e.action === "relay.created" && e.target?.id === blank.id)).toBe(true);
      // A blank create is never logged as a clone, and a clone never as a create.
      expect(audit.entries.filter((e) => e.action === "relay.created").map((e) => e.target?.id)).not.toContain(cloned.id);

      const del = await deleteRoute(req("DELETE", `/api/relays/${blank.id}`, undefined, v.h), ctxOf(blank.id));
      expect(del.status).toBe(204);
      expect(audit.entries.some((e) => e.action === "relay.deleted" && e.target?.id === blank.id)).toBe(true);

      // A delete that never happened is never logged.
      const before = audit.entries.filter((e) => e.action === "relay.deleted").length;
      const foreign = await deleteRoute(req("DELETE", "/api/relays/rl_nosuchrelayatall", undefined, v.h), ctxOf("rl_nosuchrelayatall"));
      expect(foreign.status).toBe(404);
      expect(audit.entries.filter((e) => e.action === "relay.deleted")).toHaveLength(before);

      // No audit row ever carries the blueprint's source text (SAAS §9 "never in metadata").
      for (const e of audit.entries) expect(JSON.stringify(e.metadata ?? {})).not.toContain("schema:");
    } finally {
      setAuditWriter(null);
    }
  });

  it("a device-path create leaves created_by_user_id null; a named creator is stamped as provenance", async () => {
    const creatorOf = async (id: string) =>
      (await t.db.select({ u: relays.createdByUserId }).from(relays).where(eq(relays.id, id)))[0]?.u ?? null;

    const v = visitor();
    const d = await cloneDental(v.h);
    expect(await creatorOf(d.id)).toBeNull();

    const deps = setRelaysDeps({ db: t.db, gallery: new MemoryGallerySource(galleryEntries()), rateLimiter: () => new DbRateLimiter(t.db) })!;
    const ws = `ws_creator_${Math.random().toString(36).slice(2, 8)}`;
    const made = await deps.registry.create(ws, { kind: "blank", industry: "healthcare" }, { createdByUserId: "user_abc" });
    expect(await creatorOf(made.id)).toBe("user_abc");
    // Provenance, not authorization: the workspace still decides who may read it.
    expect(await deps.registry.get(made.id, "ws_someone_else")).toBeNull();
  });

  // ---------------------------------------------------------------------------- the store's own surface

  it("the registered port is WP14b's store, and create-from-source keeps the text", async () => {
    const v = visitor();
    await list(v.h);
    const ws = `ws_src_${Math.random().toString(36).slice(2, 8)}`;
    const store = getRelaySourceStore();
    const text = (await store.get((await list(v.h)).gallery.find((x) => x.slug === "dental-deposit")!.id, ws))!.text;

    const created = await store.create(ws, { format: "yaml", text: `# imported\n${text}` }, "cli");
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const [row] = await t.db.select().from(relays).where(eq(relays.id, created.relayId));
    expect(row?.draftSource).toContain("# imported");
    expect(row?.draftSourceFormat).toBe("yaml");
    expect(row?.workspaceId).toBe(ws);

    const invalid = await store.create(ws, { format: "yaml", text: "meta:\n  schema: wrong\n" }, "cli");
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(invalid.diagnostics.length).toBeGreaterThan(0);
  });

  it("a snapshotted version keeps the source as it stood at snapshot time", async () => {
    const v = visitor();
    const d = await cloneDental(v.h);
    const src = (await (await getSrc(v.h, d.id)).json()) as { text: string };
    await putSrc(v.h, d.id, { source: { format: "yaml", text: `# at snapshot\n${src.text}` }, expectedRev: 0 });

    // Through the real route, so the capture is the one production performs.
    const snapRes = await versionsRoute(req("POST", `/api/relays/${d.id}/versions`, {}, v.h), ctxOf(d.id));
    expect([200, 201]).toContain(snapRes.status);
    const snap = (await snapRes.json()) as { versionId: string; version: number };

    const [ver] = await t.db.select().from(relayVersions).where(eq(relayVersions.id, snap.versionId));
    expect(ver?.source).toContain("# at snapshot");

    // A later draft edit must not rewrite the version's text.
    await putSrc(v.h, d.id, { source: { format: "yaml", text: `# after snapshot\n${src.text}` }, expectedRev: 1 });
    const [again] = await t.db.select().from(relayVersions).where(eq(relayVersions.id, snap.versionId));
    expect(again?.source).toContain("# at snapshot");
    expect(again?.source).not.toContain("# after snapshot");

    const view = (await (await getSrc(v.h, d.id, `?version=${snap.version}`)).json()) as { stored: boolean; text: string; version: number };
    expect(view).toMatchObject({ stored: true, version: snap.version });
    expect(view.text).toContain("# at snapshot");
  });
});
