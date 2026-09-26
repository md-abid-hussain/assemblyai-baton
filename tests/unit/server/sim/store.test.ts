import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type OpenAI from "openai";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { GallerySimCall, SimCallInsert, SimCallStore, TtsCacheStore } from "@/core/contracts/ext/wp17-sim";
import { TtsService } from "@/server/openai/tts";
import { voiceSimCall } from "@/server/sim/generate";
import { serveSimCallAsset } from "@/server/sim/routes";
import { GallerySimCatalog, MemorySimCallStore, PgSimCallStore, purgeSimCalls, purgeTtsCache, simManifestEntry } from "@/server/sim/store";
import { MemoryTtsCache, PgTtsCache } from "@/server/sim/tts-cache";
import { blueprintFixture, createSimTestDb, fakeLedger, fakeSpeak, HAS_DB, scriptFixture, type TestDb } from "./helpers";

const relay = { relayId: "rl_dental", slug: "dental-deposit", title: "Dental deposit", blueprintHash: null };

async function voiced(cache: TtsCacheStore, id: string): Promise<SimCallInsert> {
  const tts = new TtsService({ openai: () => ({}) as OpenAI, cache, ledger: () => fakeLedger(), env: () => "dev-wp17", speak: fakeSpeak({ msPerChar: 30 }) });
  const v = await voiceSimCall(tts, { simCallId: id, script: scriptFixture(), blueprint: blueprintFixture, sampleIndex: 0, relay, relayVersionId: "rv_x", gallery: false });
  return v.row;
}

function dryRun(row: SimCallInsert, id: string): SimCallInsert {
  return { ...row, id, kind: "text_dry_run", rep: null, customer: null, peaks: null, aiClips: {} };
}

function gallery(row: SimCallInsert, id: string): GallerySimCall {
  const entry = simManifestEntry({ id, durationMs: row.durationMs, handoff: row.handoff, script: row.script });
  return {
    id, relay: { ...relay, blueprintHash: "bp_hash" }, sampleIndex: 0,
    entry: { ...entry, assets: { rep: `/calls/sim-dental-deposit/rep.ulaw`, customer: `/calls/sim-dental-deposit/customer.ulaw`, peaks: `/calls/sim-dental-deposit/peaks.json` } },
    aiClips: { confirm: { ...row.aiClips.confirm!, url: `/calls/sim-dental-deposit/clip.${row.aiClips.confirm!.hash}.pcm` } },
    timeline: row.script.timeline,
    variants: [],
  };
}

/** One behaviour suite for every `SimCallStore` implementation. */
function storeSuite(name: string, make: () => Promise<{ store: SimCallStore; cache: TtsCacheStore; galleryRow: GallerySimCall[] }>) {
  describe(name, () => {
    let store: SimCallStore;
    let cache: TtsCacheStore;
    let row: SimCallInsert;
    const id = "sim_0123456789abcdef";

    beforeAll(async () => {
      const m = await make();
      store = m.store;
      cache = m.cache;
      row = await voiced(cache, id);
      m.galleryRow.push(gallery(row, "sim_feedfacefeedface"));
      expect(await store.insert(row)).toEqual({ id, created: true });
    });

    it("inserts once (content-addressed) and reads the row back without audio bytes", async () => {
      expect(await store.insert({ ...row, usd: 99 })).toEqual({ id, created: false });
      const rec = (await store.get(id))!;
      expect(rec).toMatchObject({ id, kind: "audio", relayVersionId: "rv_x", sampleIndex: 0, durationMs: row.durationMs, usd: row.usd, gallery: false, hasAudio: true });
      expect(rec.script).toEqual(row.script);
      expect(rec.handoff).toEqual(row.handoff);
      expect(rec.aiClips).toEqual(row.aiClips);
      expect(rec.peaks).toEqual(row.peaks);
      expect("rep" in rec).toBe(false);
      expect(await store.get("sim_ffffffffffffffff")).toBeNull();
    });

    it("serves the assets: both channels byte-exact, peaks JSON, referenced clips only", async () => {
      expect(Buffer.from((await store.asset(id, "rep.ulaw"))!.bytes).equals(Buffer.from(row.rep!))).toBe(true);
      expect(Buffer.from((await store.asset(id, "customer.ulaw"))!.bytes).equals(Buffer.from(row.customer!))).toBe(true);
      const peaks = await store.asset(id, "peaks.json");
      expect(peaks!.contentType).toBe("application/json");
      expect(JSON.parse(Buffer.from(peaks!.bytes).toString("utf8"))).toEqual(row.peaks);
      const h = row.aiClips.close!.hash;
      const clip = (await store.asset(id, `clip.${h}.pcm`))!;
      expect(Buffer.from(clip.bytes).equals(Buffer.from((await cache.get(h))!.pcm24k))).toBe(true);
      const lineOnly = row.script.timeline[0]!.clipHash; // a human-half clip, not an AI clip
      expect(await store.asset(id, `clip.${lineOnly}.pcm`)).toBeNull();
      expect(await store.asset(id, "../etc/passwd")).toBeNull();
    });

    it("resolves audio sims, then gallery sims; never a text dry run", async () => {
      const r = (await store.resolveCall(id))!;
      expect(r.entry.callId).toBe(id);
      expect(r.relayVersionId).toBe("rv_x");
      const g = (await store.resolveCall("sim_feedfacefeedface"))!;
      expect(g).toMatchObject({ gallery: true, relayVersionId: null, relay: { slug: "dental-deposit", blueprintHash: "bp_hash" } });
      expect(g.entry.assets!.rep).toBe("/calls/sim-dental-deposit/rep.ulaw");
      const dry = "sim_00000000000000d1";
      await store.insert(dryRun(row, dry));
      expect((await store.get(dry))!.hasAudio).toBe(false);
      expect(await store.resolveCall(dry)).toBeNull();
      expect(await store.asset(dry, "rep.ulaw")).toBeNull();
      expect(await store.resolveCall("s01_take1")).toBeNull();
    });

    it("the asset route serves immutable bytes, 304s on the ETag and 404s the rest", async () => {
      const req = (h: Record<string, string> = {}) => new Request(`http://x/api/sim-calls/${id}/rep.ulaw`, { headers: h });
      const ok = await serveSimCallAsset(req(), id, "rep.ulaw", store);
      expect(ok.status).toBe(200);
      expect(ok.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
      expect(ok.headers.get("content-length")).toBe(String(row.rep!.length));
      expect(Buffer.from(await ok.arrayBuffer()).equals(Buffer.from(row.rep!))).toBe(true);
      const etag = ok.headers.get("etag")!;
      expect((await serveSimCallAsset(req({ "if-none-match": etag }), id, "rep.ulaw", store)).status).toBe(304);
      const clip = `clip.${row.aiClips.consent!.hash}.pcm`;
      const c = await serveSimCallAsset(req(), id, clip, store);
      expect(c.status).toBe(200);
      expect((await serveSimCallAsset(req({ "if-none-match": c.headers.get("etag")! }), id, clip, store)).status).toBe(304);
      for (const [i, f] of [["sim_ffffffffffffffff", "rep.ulaw"], [id, "rep.wav"], ["nope", "rep.ulaw"], [id, `clip.${"0".repeat(64)}.pcm`]] as const) {
        const r = await serveSimCallAsset(req(), i, f, store);
        expect(r.status).toBe(404);
        expect(r.headers.get("cache-control")).toBe("no-store");
      }
      expect((await serveSimCallAsset(req({ "if-none-match": `"sim_ffffffffffffffff/rep.ulaw"` }), "sim_ffffffffffffffff", "rep.ulaw", store)).status).toBe(404);
    });
  });
}

storeSuite("MemorySimCallStore", async () => {
  const cache = new MemoryTtsCache();
  const galleryRow: GallerySimCall[] = [];
  return { store: new MemorySimCallStore({ tts: cache, gallery: new GallerySimCatalog({ entries: galleryRow }) }), cache, galleryRow };
});

describe.skipIf(!HAS_DB)("Postgres", () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await createSimTestDb("wp17sim");
  });
  afterAll(async () => {
    await t?.drop();
  });

  storeSuite("PgSimCallStore + PgTtsCache", async () => {
    const cache = new PgTtsCache(t.db);
    const galleryRow: GallerySimCall[] = [];
    return { store: new PgSimCallStore({ db: t.db, tts: cache, gallery: new GallerySimCatalog({ entries: galleryRow }) }), cache, galleryRow };
  });

  it("purges idle and over-cap non-gallery sims, and unreferenced old TTS clips", async () => {
    const cache = new PgTtsCache(t.db);
    const store = new PgSimCallStore({ db: t.db, tts: cache, gallery: new GallerySimCatalog({ entries: [] }) });
    const base = await voiced(cache, "sim_1000000000000000");
    const ids = ["sim_1000000000000001", "sim_1000000000000002", "sim_1000000000000003", "sim_1000000000000004"];
    for (const id of ids) await store.insert({ ...base, id });
    await store.insert({ ...base, id: "sim_1000000000000005", gallery: true });
    await t.pool.query(`update sim_calls set last_used_at = now() - interval '8 days' where id = $1`, [ids[0]]);
    await t.pool.query(`update sim_calls set last_used_at = now() - interval '8 days' where id = 'sim_1000000000000005'`);
    await t.pool.query(`update sim_calls set last_used_at = now() - interval '1 day' where id = $1`, [ids[1]]);
    const before = Number((await t.pool.query(`select count(*)::int as n from sim_calls where gallery = false`)).rows[0].n);
    const deleted = await purgeSimCalls(t.db, { maxRows: before - 2 });
    const left = (await t.pool.query(`select id from sim_calls order by id`)).rows.map((r: { id: string }) => r.id);
    expect(left).not.toContain(ids[0]);
    expect(left).toContain("sim_1000000000000005");
    expect(deleted).toBe(2);
    expect(left).not.toContain(ids[1]); // the least recently used beyond the cap

    await t.pool.query(`update tts_cache set created_at = now() - interval '15 days'`);
    const n = await purgeTtsCache(t.db);
    const kept = (await t.pool.query(`select hash from tts_cache`)).rows.map((r: { hash: string }) => r.hash);
    for (const c of Object.values(base.aiClips)) expect(kept).toContain(c.hash);
    expect(n).toBeGreaterThan(0);
    expect(kept.length).toBe(new Set(Object.values(base.aiClips).map((c) => c.hash)).size);
  });

  it("the TTS cache round-trips bytes and ignores duplicate puts", async () => {
    const cache = new PgTtsCache(t.db);
    const e = { hash: "b".repeat(64), model: "m", voice: "marin", text: "hi", pcm24k: new Uint8Array([1, 2, 3, 4]), durationMs: 0 };
    await cache.put(e);
    await cache.put({ ...e, pcm24k: new Uint8Array([9, 9]) });
    expect(Array.from((await cache.get(e.hash))!.pcm24k)).toEqual([1, 2, 3, 4]);
    expect(await cache.get("c".repeat(64))).toBeNull();
  });
});

describe("GallerySimCatalog", () => {
  it("defaults to the bundled manifest import (empty until WP17·2 builds the gallery)", async () => {
    expect(Array.isArray(await new GallerySimCatalog().list())).toBe(true);
  });

  it("reads src/generated/sim-calls.json under the root; a missing or invalid file is empty", async () => {
    const root = mkdtempSync(join(tmpdir(), "wp17-gallery-"));
    expect(await new GallerySimCatalog({ root }).list()).toEqual([]);
    const row = await voiced(new MemoryTtsCache(), "sim_2000000000000000");
    mkdirSync(join(root, "src/generated"), { recursive: true });
    writeFileSync(join(root, "src/generated/sim-calls.json"), JSON.stringify([gallery(row, "sim_2000000000000001")]));
    const c = new GallerySimCatalog({ root, ttlMs: 0 });
    expect((await c.get("sim_2000000000000001"))?.relay.slug).toBe("dental-deposit");
    writeFileSync(join(root, "src/generated/sim-calls.json"), JSON.stringify([{ id: "bad" }]));
    expect(await c.list()).toEqual([]);
  });
});
