/**
 * PgRelayRegistry over real Postgres (TASKS-v2 WP14b T1): seed idempotency and presets, create (blank, clone, clone of
 * a preset version, blueprint), optimistic drafts, content-addressed versions, workspace isolation, moderation caching,
 * soft delete, and the LRU archive at the global cap. $0 (fake moderator, stub gallery).
 */
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { BatonError } from "@/core/contracts/errors";
import { GALLERY_WORKSPACE, RelayDetailSchema, type Blueprint } from "@/core/contracts/v2";
import { relays, relayVersions } from "@/server/db/schema";
import { blueprintHash } from "@/server/relays/canonical";
import { RelayError } from "@/server/relays/http";
import { applyJsonPatch } from "@/server/relays/json-patch";
import { ModerationUnavailableError, type Moderator } from "@/server/relays/moderation";
import { PgRelayRegistry } from "@/server/relays/registry";
import { MemoryGallerySource, type GalleryEntry } from "@/server/relays/seed";
import { createTestDb, HAS_DB, type TestDb } from "../cases/helpers/test-db";
import { DENTAL_PRESETS, dentalBlueprint, galleryEntries, scalar } from "./helpers";

class FakeModerator implements Moderator {
  calls: string[] = [];
  constructor(private readonly flag: (text: string) => boolean = () => false) {}
  async check(text: string) {
    this.calls.push(text);
    const flagged = this.flag(text);
    return { flagged, categories: flagged ? ["harassment"] : [] };
  }
}

const WS_A = "ws_visitorA";
const WS_B = "ws_visitorB";

describe.skipIf(!HAS_DB)("PgRelayRegistry", () => {
  let t: TestDb;
  let reg: PgRelayRegistry;
  let entries: GalleryEntry[];
  const moderator = new FakeModerator((txt) => txt.includes("FLAG-ME"));

  beforeAll(async () => {
    t = await createTestDb("wp14b_registry");
    entries = galleryEntries();
    reg = new PgRelayRegistry({ db: t.db, gallery: new MemoryGallerySource(entries), moderator });
  });
  afterAll(async () => {
    await t?.drop();
  });

  const galleryId = async (slug: string) => (await reg.findRow(slug))!.id;

  it("seedGallery: first boot creates the gallery versions and presets; a second boot creates 0 and writes nothing", async () => {
    const first = await reg.seedGallery();
    expect(first.errors).toEqual([]);
    expect(first.upserted.sort()).toEqual(["baton-add-driver", "dental-deposit"]);
    expect(first.versionsCreated).toBe(1 + 1 + DENTAL_PRESETS.length);
    const before = await t.db.select().from(relays);
    const second = await reg.seedGallery();
    expect(second.versionsCreated).toBe(0);
    expect(second.errors).toEqual([]);
    const after = await t.db.select().from(relays);
    expect(after.map((r) => [r.id, r.draftRev, r.updatedAt.getTime(), r.currentVersionId])).toEqual(
      before.map((r) => [r.id, r.draftRev, r.updatedAt.getTime(), r.currentVersionId]),
    );
    const n = await scalar(t.db, sql`select count(*)::int as n from relay_versions`);
    expect(n).toBe(4);
  });

  it("gallery: flagship first, read-only, the file's hash, seed-moderated, presets of the current version", async () => {
    const gallery = await reg.listGallery();
    expect(gallery.map((g) => [g.slug, g.flagship, g.visibility, g.origin])).toEqual([
      ["baton-add-driver", true, "gallery", "seed"],
      ["dental-deposit", false, "gallery", "seed"],
    ]);
    expect(gallery[1]).toMatchObject({ industry: "healthcare", versionCount: 1, lintErrors: 0, lastRunAt: null });
    const d = (await reg.get("dental-deposit", WS_A))!;
    RelayDetailSchema.parse(d);
    expect(d.readOnly).toBe(true);
    const v = (await reg.getVersion(d.currentVersionId!))!;
    expect(v.hash).toBe(blueprintHash(dentalBlueprint()));
    expect(v.version).toBe(1);
    expect(d.presets.map((p) => [p.id, p.label])).toEqual(DENTAL_PRESETS.map((p) => [p.id, p.label]));
    const p75 = (await reg.getVersion(d.presets[0]!.versionId))!;
    expect(p75.hash).toBe(blueprintHash(applyJsonPatch(dentalBlueprint(), DENTAL_PRESETS[0]!.patch)));
    expect(p75.blueprint.context.samples[0]!.tables.treatments![0]!.deposit_usd).toBe("75.00");
    expect(await reg.moderate(d.presets[0]!.versionId)).toEqual({ flagged: false, categories: [] });
    expect(moderator.calls).toHaveLength(0); // seeded text is never sent out
    expect(await reg.listMine(GALLERY_WORKSPACE)).toEqual([]);
  });

  it("seedGallery follows a changed file: a new version becomes current and the presets are rebased", async () => {
    const original = (await reg.get("dental-deposit", WS_A))!;
    const changed = dentalBlueprint();
    changed.meta.tagline = "Now with a new tagline.";
    const reg2 = new PgRelayRegistry({ db: t.db, gallery: new MemoryGallerySource([{ ...entries[1]!, json: changed }]) });
    const r = await reg2.seedGallery();
    expect(r.versionsCreated).toBe(1 + DENTAL_PRESETS.length);
    const d = (await reg2.get("dental-deposit", WS_A))!;
    expect((await reg2.getVersion(d.currentVersionId!))!.version).toBe(4); // v1 base, v2-3 presets, v4 new base, v5-6 presets
    expect(d.draft.meta.tagline).toBe("Now with a new tagline.");
    expect(d.draftRev).toBe(original.draftRev + 1);
    expect(d.presets).toHaveLength(2);
    for (const p of d.presets) expect((await reg2.getVersion(p.versionId))!.blueprint.meta.tagline).toBe("Now with a new tagline.");
    // and back: the original file reuses its old version and presets (content-addressed), no new rows
    expect((await reg.seedGallery()).versionsCreated).toBe(0);
    const back = (await reg.get("dental-deposit", WS_A))!;
    expect(back.currentVersionId).toBe(original.currentVersionId);
    expect(back.presets).toEqual(original.presets);
    expect(back.versionCount).toBe(2);
  });

  it("create: blank, clone of a gallery relay, clone of a preset version, from a blueprint", async () => {
    const blank = await reg.create(WS_A, { kind: "blank", industry: "retail" });
    RelayDetailSchema.parse(blank);
    expect(blank).toMatchObject({ origin: "user", visibility: "private", readOnly: false, draftRev: 0, currentVersionId: null, versionCount: 0, industry: "retail" });
    expect(blank.id).toMatch(/^rl_/);
    expect(blank.slug).toMatch(/^untitled-relay-[a-z0-9]{8}$/);

    const clone = await reg.create(WS_A, { kind: "clone", relayId: await galleryId("dental-deposit") });
    expect(clone).toMatchObject({ origin: "clone", readOnly: false, title: "Dental deposit", presets: [] });
    expect(clone.draft.meta.origin).toBe("clone");
    expect(clone.slug).toMatch(/^dental-deposit-[a-z0-9]{8}$/);

    const gallery = (await reg.get("dental-deposit", WS_A))!;
    const fromPreset = await reg.create(WS_B, { kind: "clone", relayId: gallery.presets[1]!.versionId });
    expect(fromPreset.draft.fields.map((f) => f.id)).toContain("insurer");

    const bp = dentalBlueprint();
    bp.meta.title = "My own desk";
    const own = await reg.create(WS_A, { kind: "blueprint", blueprint: bp, origin: "draft" });
    expect(own).toMatchObject({ origin: "draft", title: "My own desk" });

    await expect(reg.create(WS_A, { kind: "blueprint", blueprint: { meta: {} }, origin: "user" })).rejects.toMatchObject({ code: "E_LINT" });
    await expect(reg.create(WS_A, { kind: "clone", relayId: "rl_nope" })).rejects.toMatchObject({ code: "E_NOT_FOUND" });
    await expect(reg.create(WS_A, { kind: "blank", industry: "space" })).rejects.toMatchObject({ code: "E_BAD_REQUEST" });
  });

  it("saveDraft: optimistic rev, conflict, schema failure stores nothing, read-only and isolation", async () => {
    const r = await reg.create(WS_A, { kind: "clone", relayId: await galleryId("dental-deposit") });
    const bp: Blueprint = structuredClone(r.draft);
    bp.meta.title = "Renamed desk";
    expect(await reg.saveDraft(r.id, WS_A, bp, 0)).toEqual({ rev: 1, lint: [] });
    expect(await reg.saveDraft(r.id, WS_A, bp, 0)).toEqual({ conflict: true, rev: 1 });
    const bad = structuredClone(bp) as unknown as { fields: unknown[] };
    bad.fields = [];
    const e = await reg.saveDraft(r.id, WS_A, bad, 1).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(RelayError);
    expect((e as RelayError).code).toBe("E_LINT");
    expect((e as RelayError).extra.lint?.[0]).toMatchObject({ code: "SCHEMA", path: ["fields"] });
    const now = (await reg.get(r.id, WS_A))!;
    expect(now).toMatchObject({ draftRev: 1, title: "Renamed desk" });
    await expect(reg.saveDraft(await galleryId("dental-deposit"), WS_A, bp, 0)).rejects.toMatchObject({ code: "E_READ_ONLY" });
    await expect(reg.saveDraft(r.id, WS_B, bp, 1)).rejects.toMatchObject({ code: "E_NOT_FOUND" });
  });

  it("snapshotVersion is content-addressed: same draft → same version; an edit → v2; a revert → v1 again", async () => {
    const r = await reg.create(WS_A, { kind: "blank", industry: "other" });
    const s1 = await reg.snapshotVersion(r.id);
    expect(s1).toMatchObject({ version: 1, created: true });
    expect(s1.hash).toBe(blueprintHash(r.draft));
    expect(await reg.snapshotVersion(r.id)).toEqual({ ...s1, created: false });
    const bp = structuredClone(r.draft);
    bp.meta.tagline = "edited";
    await reg.saveDraft(r.id, WS_A, bp, 0);
    const s2 = await reg.snapshotVersion(r.id);
    expect(s2).toMatchObject({ version: 2, created: true });
    await reg.saveDraft(r.id, WS_A, r.draft, 1);
    expect(await reg.snapshotVersion(r.id)).toEqual({ ...s1, created: false });
    const d = (await reg.get(r.id, WS_A))!;
    expect(d.currentVersionId).toBe(s1.versionId);
    expect(d.versionCount).toBe(2);
    expect(await reg.getVersion("rv_missing")).toBeNull();
    expect(await reg.getVersion("nope")).toBeNull();
  });

  it("workspace isolation: private is invisible to others, unlisted is read-only, lists are per workspace", async () => {
    const r = await reg.create(WS_A, { kind: "blank", industry: "telecom" });
    expect(await reg.get(r.id, WS_B)).toBeNull();
    expect(await reg.get(r.slug, WS_B)).toBeNull();
    expect((await reg.listMine(WS_B)).map((x) => x.id)).not.toContain(r.id);
    expect((await reg.listMine(WS_A)).map((x) => x.id)).toContain(r.id);
    await reg.setVisibility(r.id, WS_A, "unlisted");
    const seen = (await reg.get(r.slug, WS_B))!;
    expect(seen).toMatchObject({ id: r.id, readOnly: true, visibility: "unlisted" });
    await expect(reg.setVisibility(r.id, WS_B, "private")).rejects.toMatchObject({ code: "E_READ_ONLY" });
    await expect(reg.remove(r.id, WS_B)).rejects.toMatchObject({ code: "E_READ_ONLY" });
    // a cross-workspace clone of an unlisted relay works
    expect((await reg.create(WS_B, { kind: "clone", relayId: r.slug })).origin).toBe("clone");
    await expect(reg.setVisibility(await galleryId("dental-deposit"), WS_A, "private")).rejects.toMatchObject({ code: "E_READ_ONLY" });
  });

  it("moderate: gallery text is pre-cleared with no call; new text is checked once and stored; flagged is stored", async () => {
    const r = await reg.create(WS_A, { kind: "clone", relayId: await galleryId("dental-deposit") });
    const s0 = await reg.snapshotVersion(r.id);
    const before = moderator.calls.length;
    expect(await reg.moderateForRun(s0.versionId, "test")).toEqual({ flagged: false, categories: [], via: "gallery_text" });
    expect(await reg.moderateForRun(s0.versionId, "publish")).toEqual({ flagged: false, categories: [], via: "stored" });
    const [row0] = await t.db.select({ m: relayVersions.moderation }).from(relayVersions).where(eq(relayVersions.id, s0.versionId));
    expect(row0!.m).toMatchObject({ flagged: false, source: "seed" });
    expect(moderator.calls).toHaveLength(before);
    const bp = structuredClone(r.draft);
    bp.meta.title = "Brightwater front desk";
    await reg.saveDraft(r.id, WS_A, bp, 0);
    const s = await reg.snapshotVersion(r.id);
    expect(await reg.moderate(s.versionId)).toEqual({ flagged: false, categories: [] });
    expect(await reg.moderate(s.versionId)).toEqual({ flagged: false, categories: [] });
    expect(moderator.calls).toHaveLength(before + 1);
    expect(moderator.calls.at(-1)).toContain("Brightwater front desk");
    bp.playbook.persona.tone = "FLAG-ME";
    await reg.saveDraft(r.id, WS_A, bp, 1);
    const s2 = await reg.snapshotVersion(r.id);
    expect(await reg.moderate(s2.versionId)).toEqual({ flagged: true, categories: ["harassment"] });
    const [row] = await t.db.select({ m: relayVersions.moderation }).from(relayVersions).where(eq(relayVersions.id, s2.versionId));
    expect(row!.m).toMatchObject({ flagged: true, categories: ["harassment"], source: "openai" });
    await expect(reg.moderate("rv_none")).rejects.toMatchObject({ code: "E_NOT_FOUND" });
  });

  it("moderation unavailable (PLATFORM §7.4): Publish fails closed; a Test run fails open only for gallery-derived relays, unstored", async () => {
    let down = true;
    const flaky: Moderator = {
      async check() {
        if (down) throw new ModerationUnavailableError("down");
        return { flagged: false, categories: [] };
      },
    };
    const r2 = new PgRelayRegistry({ db: t.db, moderator: flaky });
    const clone = await r2.create(WS_A, { kind: "clone", relayId: await galleryId("dental-deposit") });
    const bp = structuredClone(clone.draft);
    bp.meta.title = "Another desk entirely";
    await r2.saveDraft(clone.id, WS_A, bp, 0);
    const cv = (await r2.snapshotVersion(clone.id)).versionId;
    expect(await r2.moderateForRun(cv, "test")).toEqual({ flagged: false, categories: [], via: "fail_open" });
    await expect(r2.moderate(cv)).rejects.toMatchObject({ code: "E_MAINTENANCE" });
    const blank = await r2.create(WS_A, { kind: "blank", industry: "other" });
    const bv = (await r2.snapshotVersion(blank.id)).versionId;
    await expect(r2.moderateForRun(bv, "test")).rejects.toMatchObject({ code: "E_MAINTENANCE" });
    const bare = new PgRelayRegistry({ db: t.db }); // no moderator at all = unavailable
    await expect(bare.moderateForRun(bv, "test")).rejects.toMatchObject({ code: "E_MAINTENANCE" });
    expect(await bare.moderateForRun(cv, "test")).toMatchObject({ via: "fail_open" });
    down = false;
    expect(await r2.moderateForRun(cv, "test")).toEqual({ flagged: false, categories: [], via: "openai" }); // nothing was stored while down
    expect(await r2.moderateForRun(cv, "publish")).toMatchObject({ via: "stored" });
    const boom = new PgRelayRegistry({ db: t.db, moderator: { check: async () => { throw new Error("a bug, not an outage"); } } });
    await expect(boom.moderateForRun(bv, "test")).rejects.toThrow("a bug, not an outage");
  });

  it("run resolution: owner draft → snapshot; reader → current version; presets by version id; isolation 404; canSeeVersion", async () => {
    const dentalId = await galleryId("dental-deposit");
    const g = await reg.runVersion((await reg.get(dentalId, WS_A))!.currentVersionId!);
    expect(g).toMatchObject({ relaySlug: "dental-deposit", gallery: true, flagship: false, origin: "seed", preset: null });
    const reader = await reg.resolveRun(WS_B, { relayId: "dental-deposit" });
    expect(reader.versionId).toBe(g!.versionId);
    const preset = (await reg.get(dentalId, WS_B))!.presets[0]!;
    const pr = await reg.resolveRun(WS_B, { relayVersionId: preset.versionId });
    expect(pr.preset).toMatchObject({ id: preset.id, baseVersionId: g!.versionId });
    const mine = await reg.create(WS_A, { kind: "clone", relayId: dentalId });
    const owned = await reg.resolveRun(WS_A, { relayId: mine.id });
    expect(owned).toMatchObject({ relayId: mine.id, origin: "clone", gallery: false, version: 1 });
    expect((await reg.resolveRun(WS_A, { relayId: mine.slug })).versionId).toBe(owned.versionId); // content-addressed
    await expect(reg.resolveRun(WS_B, { relayId: mine.id })).rejects.toMatchObject({ code: "E_NOT_FOUND" });
    await expect(reg.resolveRun(WS_B, { relayVersionId: owned.versionId })).rejects.toMatchObject({ code: "E_NOT_FOUND" });
    await expect(reg.resolveRun(WS_A, { relayId: "baton-add-driver", relayVersionId: owned.versionId })).rejects.toMatchObject({ code: "E_NOT_FOUND" });
    await expect(reg.resolveRun(WS_A, {})).rejects.toMatchObject({ code: "E_BAD_REQUEST" });
    expect(await reg.canSeeVersion(WS_A, owned.versionId)).toBe(true);
    expect(await reg.canSeeVersion(WS_B, owned.versionId)).toBe(false);
    expect(await reg.canSeeVersion(WS_B, preset.versionId)).toBe(true);
    expect(await reg.canSeeVersion(WS_B, "rv_nope")).toBe(false);
    expect(await reg.galleryVersionFor("dental-deposit", g!.hash)).toBe(g!.versionId);
    expect(await reg.galleryVersionFor("dental-deposit", "stale")).toBe(g!.versionId);
    expect(await reg.galleryVersionFor(mine.slug, null)).toBeNull(); // not a gallery relay
  });

  it("remove: soft delete, gone from reads and lists; gallery relays cannot be removed", async () => {
    const r = await reg.create(WS_A, { kind: "blank", industry: "other" });
    await reg.remove(r.id, WS_A);
    expect(await reg.get(r.id, WS_A)).toBeNull();
    expect((await reg.listMine(WS_A)).map((x) => x.id)).not.toContain(r.id);
    const [row] = await t.db.select().from(relays).where(eq(relays.id, r.id));
    expect(row!.deletedAt).not.toBeNull();
    await expect(reg.remove(await galleryId("baton-add-driver"), WS_A)).rejects.toMatchObject({ code: "E_READ_ONLY" });
  });
});

describe.skipIf(!HAS_DB)("PgRelayRegistry global cap (LRU archive, PLATFORM §10.2)", () => {
  let t: TestDb;
  let clock = Date.parse("2026-09-25T10:00:00Z");
  const now = () => clock;
  const HOUR = 3_600_000;
  let reg: PgRelayRegistry;

  beforeAll(async () => {
    t = await createTestDb("wp14b_evict");
    reg = new PgRelayRegistry({ db: t.db, now, caps: { softLive: 3, hardLive: 5, idleMs: HOUR }, gallery: new MemoryGallerySource(galleryEntries()) });
    await reg.seedGallery();
  });
  afterAll(async () => {
    await t?.drop();
  });

  const status = async (id: string) => (await t.db.select({ s: relays.status }).from(relays).where(eq(relays.id, id)))[0]!.s;

  it("never blocks a create: at the soft cap the least-recently-used idle relay is archived; gallery and published are never archived", async () => {
    const a = await reg.create("ws_1", { kind: "blank", industry: "other" });
    clock += 60_000;
    const b = await reg.create("ws_2", { kind: "blank", industry: "other" });
    clock += 60_000;
    const c = await reg.create("ws_3", { kind: "blank", industry: "other" });
    await t.db.update(relays).set({ status: "published" }).where(eq(relays.id, a.id)); // a is published: exempt
    clock += 2 * HOUR;
    await reg.get(b.id, "ws_2"); // b was just used
    const d = await reg.create("ws_4", { kind: "blank", industry: "other" });
    expect(d.id).toMatch(/^rl_/);
    expect([await status(a.id), await status(b.id), await status(c.id)]).toEqual(["published", "draft", "archived"]);
    expect(await reg.get(c.id, "ws_3")).toBeNull();
    expect((await reg.listGallery()).length).toBe(2);
  });

  it("at the soft cap with nothing idle, the create still succeeds (over the soft cap)", async () => {
    // live now: a (published), b, d = 3 = softLive; nothing idle > 1 h except a (published)
    const e = await reg.create("ws_5", { kind: "blank", industry: "other" });
    expect(await status(e.id)).toBe("draft");
    const n = await scalar(t.db, sql`select count(*)::int as n from relays where deleted_at is null and status <> 'archived' and visibility <> 'gallery'`);
    expect(n).toBe(4);
  });

  it("above the hard ceiling the LRU unpublished relay is archived regardless of idle time", async () => {
    clock += 60_000;
    const f = await reg.create("ws_6", { kind: "blank", industry: "other" }); // live 5 = hardLive
    clock += 60_000;
    const lru = (await t.db.execute(sql`select id from relays where deleted_at is null and status = 'draft' and visibility <> 'gallery' order by last_used_at asc limit 1`)).rows[0] as { id: string };
    const g = await reg.create("ws_7", { kind: "blank", industry: "other" }); // would be 6 > hardLive → archive 1
    expect(await status(lru.id)).toBe("archived");
    expect(await status(f.id)).toBe("draft");
    expect(await status(g.id)).toBe("draft");
  });
});
