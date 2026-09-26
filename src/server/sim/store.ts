/**
 * server/sim/store.ts - the `sim_calls` store (PLATFORM §2.4, §7.5 step 4; WP17·1) and the `SimCallStore` port that
 * WP14b's `CallCatalog.resolve(callId)` consumes after `src/generated/calls.json`:
 *
 *   resolveCall(id)  a DB row (audio sims only; touches `last_used_at`), else the committed gallery manifest
 *                    `src/generated/sim-calls.json` (static assets under `public/calls/sim-<slug>/`, WP17·2). The
 *                    manifest is a static JSON import, so it ships inside the server bundle (no file tracing).
 *                    Returns the synthesized `CallManifestEntry` (source twilio8k, picker hidden, not in eval,
 *                    `decisionPointMs = handoff.lineStartMs`, assets on the asset route) plus the relay identity,
 *                    sample index, AI-half clips and timeline. `CallCatalog` adds `account` from the version.
 *   asset(id, file)  `rep.ulaw` | `customer.ulaw` | `peaks.json` | `clip.<sha256>.pcm` for the asset route.
 *
 * Also the purge steps the WP12 purge job calls (§2.4 size guards): non-gallery sims idle > 7 days or beyond 150
 * rows, and `tts_cache` rows older than 14 days that no live sim references.
 *
 * `PgSimCallStore` uses raw SQL on migration 0001's tables (see tts-cache.ts for why).
 */
import "server-only";

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { sql } from "drizzle-orm";

import {
  GallerySimCallsSchema, SIM_CALL_ID_RE, SIM_CLIP_FILE_RE, SimAiClipsSchema, SimScriptStoredSchema, simAssetUrl, simClipFile,
  type GallerySimCall, type SimAiClipRef, type SimAiClips, type SimCallAsset, type SimCallInsert, type SimCallRecord,
  type SimCallResolution, type SimCallStore, type TtsCacheStore,
} from "../../core/contracts/ext/wp17-sim";
import { CallHandoffSchema, PeaksSchema, type CallManifestEntry } from "../../core/contracts/scenario";
import GALLERY_SIM_CALLS from "../../generated/sim-calls.json";
import type { Db } from "../db/client";
import { log } from "../log";
import { bufferOf, bytesOf } from "./tts-cache";

const storeLog = log.child({ component: "sim-store" });

export const SIM_PURGE = { idleDays: 7, maxRows: 150, ttsIdleDays: 14 } as const;
export const CONTENT_TYPES = { ulaw: "application/octet-stream", pcm: "application/octet-stream", json: "application/json" } as const;

// ============================================================================================ pure helpers

/** The synthesized manifest entry of a DB sim (PLATFORM §7.5 step 4). */
export function simManifestEntry(r: Pick<SimCallRecord, "id" | "durationMs" | "handoff" | "script">): CallManifestEntry {
  return {
    callId: r.id,
    scenarioId: `relay:${r.script.relay.slug}`,
    title: `${r.script.relay.title} · simulated call`,
    source: "twilio8k",
    language: "en",
    durationMs: r.durationMs,
    format: { encoding: "pcm_mulaw", sampleRate: 8000 },
    publishAudio: true,
    inEval: false,
    featured: false,
    picker: "hidden",
    decisionPointMs: r.handoff.lineStartMs,
    handoff: r.handoff,
    recordedAiBundle: null,
    customerTailPack: null,
    assets: { rep: simAssetUrl(r.id, "rep.ulaw"), customer: simAssetUrl(r.id, "customer.ulaw"), peaks: simAssetUrl(r.id, "peaks.json") },
  };
}

export const clipRefs = (id: string, clips: SimAiClips): Record<string, SimAiClipRef> =>
  Object.fromEntries(Object.entries(clips).map(([k, c]) => [k, { ...c, url: simAssetUrl(id, simClipFile(c.hash)) }]));

export function resolutionOfRecord(r: SimCallRecord, relayVersionId = r.relayVersionId): SimCallResolution {
  return {
    entry: simManifestEntry(r),
    simulated: true,
    relayVersionId,
    relay: r.script.relay,
    sampleIndex: r.sampleIndex,
    gallery: r.gallery,
    aiClips: clipRefs(r.id, r.aiClips),
    timeline: r.script.timeline,
  };
}

export const resolutionOfGallery = (g: GallerySimCall): SimCallResolution => ({
  entry: g.entry, simulated: true, relayVersionId: null, relay: g.relay, sampleIndex: g.sampleIndex, gallery: true, aiClips: g.aiClips, timeline: g.timeline,
});

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

// ============================================================================================ gallery manifest

/**
 * `src/generated/sim-calls.json` (WP17·2). By default the bundled import (parsed once); `root` re-reads the file under
 * that directory at most every `ttlMs` (scripts, tests); `entries` injects a list. Invalid or missing → empty.
 */
export class GallerySimCatalog {
  private cache: { at: number; list: GallerySimCall[] } | null = null;

  constructor(private readonly o: { root?: string; entries?: GallerySimCall[]; ttlMs?: number } = {}) {}

  private static parse(raw: unknown): GallerySimCall[] {
    const parsed = GallerySimCallsSchema.safeParse(raw);
    if (parsed.success) return parsed.data;
    storeLog.warn("src/generated/sim-calls.json is invalid; ignoring it", { issues: parsed.error.issues.slice(0, 3) });
    return [];
  }

  async list(): Promise<GallerySimCall[]> {
    if (this.o.entries) return this.o.entries;
    const now = Date.now();
    if (!this.o.root) {
      this.cache ??= { at: now, list: GallerySimCatalog.parse(GALLERY_SIM_CALLS) };
      return this.cache.list;
    }
    if (this.cache && now - this.cache.at < (this.o.ttlMs ?? 60_000)) return this.cache.list;
    let list: GallerySimCall[] = [];
    try {
      list = GallerySimCatalog.parse(JSON.parse(await readFile(resolve(this.o.root, "src/generated/sim-calls.json"), "utf8")) as unknown);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") storeLog.warn("cannot read src/generated/sim-calls.json", { err });
    }
    this.cache = { at: now, list };
    return list;
  }

  async get(id: string): Promise<GallerySimCall | null> {
    return (await this.list()).find((g) => g.id === id) ?? null;
  }
}

// ============================================================================================ Postgres

type MetaRow = {
  id: string; kind: "audio" | "text_dry_run"; relay_version_id: string; sample_index: number; script: unknown; peaks: unknown;
  duration_ms: number; handoff: unknown; ai_clips: unknown; usd: number; gallery: boolean; has_audio: boolean;
  created_at: Date | string; last_used_at: Date | string;
};

const iso = (d: Date | string): string => (d instanceof Date ? d.toISOString() : new Date(d).toISOString());

function recordOf(row: MetaRow): SimCallRecord {
  return {
    id: row.id,
    kind: row.kind,
    relayVersionId: row.relay_version_id,
    sampleIndex: row.sample_index,
    script: SimScriptStoredSchema.parse(row.script),
    peaks: row.peaks === null ? null : PeaksSchema.parse(row.peaks),
    durationMs: row.duration_ms,
    handoff: CallHandoffSchema.parse(row.handoff),
    aiClips: SimAiClipsSchema.parse(row.ai_clips ?? {}),
    usd: row.usd,
    gallery: row.gallery,
    hasAudio: row.has_audio,
    createdAt: iso(row.created_at),
    lastUsedAt: iso(row.last_used_at),
  };
}

export interface PgSimCallStoreDeps {
  db: Db;
  /** Where AI clips are read from (the `tts_cache`). */
  tts: TtsCacheStore;
  gallery?: GallerySimCatalog;
}

export class PgSimCallStore implements SimCallStore {
  private readonly gallery: GallerySimCatalog;

  constructor(private readonly d: PgSimCallStoreDeps) {
    this.gallery = d.gallery ?? new GallerySimCatalog();
  }

  async insert(row: SimCallInsert): Promise<{ id: string; created: boolean }> {
    assertInsertable(row);
    const r = await this.d.db.execute<{ id: string }>(sql`insert into sim_calls
      (id, kind, relay_version_id, sample_index, script, rep, customer, peaks, duration_ms, handoff, ai_clips, usd, gallery)
      values (${row.id}, ${row.kind}, ${row.relayVersionId}, ${row.sampleIndex}, ${JSON.stringify(row.script)}::jsonb,
        ${row.rep ? bufferOf(row.rep) : null}, ${row.customer ? bufferOf(row.customer) : null},
        ${row.peaks ? JSON.stringify(row.peaks) : null}::jsonb, ${Math.round(row.durationMs)}, ${JSON.stringify(row.handoff)}::jsonb,
        ${JSON.stringify(row.aiClips)}::jsonb, ${row.usd}, ${row.gallery})
      on conflict (id) do nothing returning id`);
    return { id: row.id, created: r.rows.length > 0 };
  }

  async get(id: string): Promise<SimCallRecord | null> {
    if (!SIM_CALL_ID_RE.test(id)) return null;
    const r = await this.d.db.execute<MetaRow>(sql`select id, kind, relay_version_id, sample_index, script, peaks, duration_ms, handoff,
      ai_clips, usd, gallery, (rep is not null and customer is not null) as has_audio, created_at, last_used_at
      from sim_calls where id = ${id}`);
    return r.rows[0] ? recordOf(r.rows[0]) : null;
  }

  async asset(id: string, file: string): Promise<SimCallAsset | null> {
    if (!SIM_CALL_ID_RE.test(id)) return null;
    if (file === "rep.ulaw" || file === "customer.ulaw") {
      const r = await this.d.db.execute<{ b: Buffer | null }>(
        file === "rep.ulaw" ? sql`select rep as b from sim_calls where id = ${id}` : sql`select customer as b from sim_calls where id = ${id}`,
      );
      const b = r.rows[0]?.b;
      return b ? { bytes: bytesOf(b), contentType: CONTENT_TYPES.ulaw } : null;
    }
    if (file === "peaks.json") {
      const r = await this.d.db.execute<{ peaks: unknown }>(sql`select peaks from sim_calls where id = ${id}`);
      const p = r.rows[0]?.peaks;
      return p ? { bytes: utf8(JSON.stringify(p)), contentType: CONTENT_TYPES.json } : null;
    }
    const m = SIM_CLIP_FILE_RE.exec(file);
    if (!m) return null;
    const r = await this.d.db.execute<{ ai_clips: unknown }>(sql`select ai_clips from sim_calls where id = ${id}`);
    const clips = SimAiClipsSchema.safeParse(r.rows[0]?.ai_clips ?? null);
    if (!clips.success || !Object.values(clips.data).some((c) => c.hash === m[1])) return null;
    const clip = await this.d.tts.get(m[1]!);
    return clip ? { bytes: clip.pcm24k, contentType: CONTENT_TYPES.pcm } : null;
  }

  async resolveCall(callId: string): Promise<SimCallResolution | null> {
    if (!SIM_CALL_ID_RE.test(callId)) return null;
    const rec = await this.get(callId);
    if (rec) {
      if (rec.kind !== "audio" || !rec.hasAudio) return null;
      void this.touch(callId);
      return resolutionOfRecord(rec);
    }
    const g = await this.gallery.get(callId);
    return g ? resolutionOfGallery(g) : null;
  }

  /** Best effort; never throws. */
  async touch(id: string): Promise<void> {
    await this.d.db.execute(sql`update sim_calls set last_used_at = now() where id = ${id}`).catch((err: unknown) => storeLog.warn("touch failed", { err }));
  }
}

/** Purge step for the WP12 purge job: idle non-gallery sims, then the oldest beyond the row cap. */
export async function purgeSimCalls(db: Db, o: { idleDays?: number; maxRows?: number } = {}): Promise<number> {
  const idle = o.idleDays ?? SIM_PURGE.idleDays;
  const max = o.maxRows ?? SIM_PURGE.maxRows;
  const a = await db.execute(sql`delete from sim_calls where gallery = false and last_used_at < now() - make_interval(days => ${idle})`);
  const b = await db.execute(sql`delete from sim_calls where id in (
    select id from sim_calls where gallery = false order by last_used_at desc, id offset ${max})`);
  return (a.rowCount ?? 0) + (b.rowCount ?? 0);
}

/** Purge step for the WP12 purge job: TTS clips older than 14 days that no remaining sim plays as an AI clip. */
export async function purgeTtsCache(db: Db, o: { idleDays?: number } = {}): Promise<number> {
  const idle = o.idleDays ?? SIM_PURGE.ttsIdleDays;
  const r = await db.execute(sql`delete from tts_cache t where t.created_at < now() - make_interval(days => ${idle})
    and not exists (select 1 from sim_calls s, jsonb_each(s.ai_clips) c where c.value->>'hash' = t.hash)`);
  return r.rowCount ?? 0;
}

// ============================================================================================ memory

function assertInsertable(row: SimCallInsert): void {
  if (!SIM_CALL_ID_RE.test(row.id)) throw new Error(`bad sim call id ${row.id}`);
  if (row.kind === "audio" && (!row.rep || !row.customer || !row.peaks)) throw new Error("an audio sim needs both channels and peaks");
  if (row.kind === "text_dry_run" && (row.rep || row.customer)) throw new Error("a text dry run has no audio");
}

/** In-memory `SimCallStore` (unit tests; WP14b's CallCatalog tests). Same semantics as the Pg store. */
export class MemorySimCallStore implements SimCallStore {
  readonly rows = new Map<string, SimCallInsert & { createdAt: string; lastUsedAt: string }>();
  private readonly gallery: GallerySimCatalog;

  constructor(private readonly o: { tts: TtsCacheStore; gallery?: GallerySimCatalog; now?: () => number }) {
    this.gallery = o.gallery ?? new GallerySimCatalog({ entries: [] });
  }

  private nowIso(): string {
    return new Date(this.o.now?.() ?? Date.now()).toISOString();
  }

  async insert(row: SimCallInsert): Promise<{ id: string; created: boolean }> {
    assertInsertable(row);
    if (this.rows.has(row.id)) return { id: row.id, created: false };
    const at = this.nowIso();
    this.rows.set(row.id, { ...structuredClone(row), createdAt: at, lastUsedAt: at });
    return { id: row.id, created: true };
  }

  async get(id: string): Promise<SimCallRecord | null> {
    const r = this.rows.get(id);
    if (!r) return null;
    const { rep, customer, ...rest } = r;
    return { ...structuredClone(rest), hasAudio: !!rep && !!customer };
  }

  async asset(id: string, file: string): Promise<SimCallAsset | null> {
    const r = this.rows.get(id);
    if (!r) return null;
    if (file === "rep.ulaw") return r.rep ? { bytes: r.rep, contentType: CONTENT_TYPES.ulaw } : null;
    if (file === "customer.ulaw") return r.customer ? { bytes: r.customer, contentType: CONTENT_TYPES.ulaw } : null;
    if (file === "peaks.json") return r.peaks ? { bytes: utf8(JSON.stringify(r.peaks)), contentType: CONTENT_TYPES.json } : null;
    const m = SIM_CLIP_FILE_RE.exec(file);
    if (!m || !Object.values(r.aiClips).some((c) => c.hash === m[1])) return null;
    const clip = await this.o.tts.get(m[1]!);
    return clip ? { bytes: clip.pcm24k, contentType: CONTENT_TYPES.pcm } : null;
  }

  async resolveCall(callId: string): Promise<SimCallResolution | null> {
    const rec = await this.get(callId);
    if (rec) {
      if (rec.kind !== "audio" || !rec.hasAudio) return null;
      this.rows.get(callId)!.lastUsedAt = this.nowIso();
      return resolutionOfRecord(rec);
    }
    const g = await this.gallery.get(callId);
    return g ? resolutionOfGallery(g) : null;
  }
}
