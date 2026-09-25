import "server-only";

import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";

import { and, eq, sql } from "drizzle-orm";
import { nanoid } from "nanoid";

import { RelayPresetsFileSchema, VersionPresetSchema, type RelayPresetDef } from "../../core/contracts/ext/wp14b-relays";
import { GALLERY_WORKSPACE, ID_PREFIXES, type Blueprint } from "../../core/contracts/v2";
import type { Db } from "../db/client";
import { relays, relayVersions } from "../db/schema";
import { log } from "../log";
import { canonicalJson } from "./canonical";
import { applyJsonPatch } from "./json-patch";
import type { RelayKernel } from "./kernel";

/**
 * `seedGallery()` (TASKS-v2 WP14b T1, PLATFORM §2.1, §7.5.3): upsert every gallery blueprint `data/relays/*.json`
 * into `ws_gallery` and snapshot its current version plus one version per "Try an edit" preset
 * (`data/relays/<base>.presets.json`). Idempotent by content hash: a second boot creates 0 versions and changes 0
 * rows. Runs at start-up (lazily, on the first relay request; `index.ts`) on every container: an advisory
 * transaction lock serializes concurrent seeds.
 *
 * The file content is hashed exactly as parsed (never rewritten), so a version's `blueprint_hash` equals the hash that
 * WP11/WP17 computed for the recorded bundles and sims of the same file (PLATFORM §10.4).
 * Seeded versions are pre-marked as moderated (`source: "seed"`): our own gallery text is not sent to OpenAI.
 */

/** The flagship's file (Baton). Only it gets `flagship: true` (PLATFORM §2.1). */
export const FLAGSHIP_FILES = ["baton-add-driver.json"] as const;

export interface GalleryEntry {
  /** File name, e.g. "dental-deposit.json". */
  file: string;
  json: unknown;
  presets: RelayPresetDef[];
}

export interface GallerySource {
  load(): Promise<{ entries: GalleryEntry[]; errors: string[] }>;
}

export interface SeedResult {
  upserted: string[];
  versionsCreated: number;
  errors: string[];
}

/** `data/relays/*.json` (top level only; `cards/**` are blueprint-only cards, never seeded). */
export class FsGallerySource implements GallerySource {
  constructor(private readonly dir: string = join(process.cwd(), "data", "relays")) {}

  async load(): Promise<{ entries: GalleryEntry[]; errors: string[] }> {
    const errors: string[] = [];
    if (!existsSync(this.dir)) return { entries: [], errors };
    const files = (await readdir(this.dir)).filter((f) => f.endsWith(".json") && !f.endsWith(".presets.json")).sort();
    const entries: GalleryEntry[] = [];
    for (const file of files) {
      let json: unknown;
      try {
        json = JSON.parse(await readFile(join(this.dir, file), "utf8"));
      } catch (e) {
        errors.push(`${file}: unreadable JSON (${e instanceof Error ? e.message : String(e)})`);
        continue;
      }
      let presets: RelayPresetDef[] = [];
      const pf = join(this.dir, `${basename(file, ".json")}.presets.json`);
      if (existsSync(pf)) {
        try {
          const r = RelayPresetsFileSchema.safeParse(JSON.parse(await readFile(pf, "utf8")));
          if (r.success) presets = r.data;
          else errors.push(`${basename(pf)}: ${r.error.issues[0]?.message ?? "invalid"}`);
        } catch (e) {
          errors.push(`${basename(pf)}: unreadable JSON (${e instanceof Error ? e.message : String(e)})`);
        }
      }
      entries.push({ file, json, presets });
    }
    return { entries, errors };
  }
}

/** A fixed in-memory gallery (tests, and the stub before WP14a·2/WP17 ship their JSON). */
export class MemoryGallerySource implements GallerySource {
  constructor(private readonly entries: GalleryEntry[]) {}
  async load(): Promise<{ entries: GalleryEntry[]; errors: string[] }> {
    return { entries: structuredClone(this.entries), errors: [] };
  }
}

const seedLog = log.child({ component: "relays-seed" });
type Json = Record<string, unknown>;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export async function seedGallery(i: { db: Db; kernel: RelayKernel; source: GallerySource; now?: () => number }): Promise<SeedResult> {
  const now = i.now ?? Date.now;
  const { entries, errors } = await i.source.load();
  const out: SeedResult = { upserted: [], versionsCreated: 0, errors: [...errors] };
  for (const entry of entries) {
    const p = i.kernel.parse(entry.json);
    if (!p.blueprint) {
      out.errors.push(`${entry.file}: does not match BlueprintSchema (${p.issues.slice(0, 3).map((x) => `${x.path.join(".")}: ${x.message}`).join("; ")})`);
      continue;
    }
    const bp = p.blueprint;
    try {
      const created = await i.db.transaction((tx) => seedOne(tx, i.kernel, entry, bp, p.issues, new Date(now()), out.errors));
      out.versionsCreated += created;
      out.upserted.push(bp.meta.slug);
    } catch (e) {
      out.errors.push(`${entry.file}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (out.errors.length) seedLog.warn("gallery seed finished with errors", { errors: out.errors });
  else seedLog.info("gallery seeded", { relays: out.upserted.length, versionsCreated: out.versionsCreated });
  return out;
}

async function seedOne(tx: Tx, kernel: RelayKernel, entry: GalleryEntry, bp: Blueprint, lint: unknown[], now: Date, errors: string[]): Promise<number> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext('relays:seed'))`);
  const slug = bp.meta.slug;
  const flagship = (FLAGSHIP_FILES as readonly string[]).includes(entry.file);
  let created = 0;

  let [row] = await tx.select().from(relays).where(eq(relays.slug, slug)).limit(1);
  if (row && row.workspaceId !== GALLERY_WORKSPACE) throw new Error(`slug "${slug}" is taken by a non-gallery relay`);
  if (!row) {
    [row] = await tx
      .insert(relays)
      .values({
        id: `${ID_PREFIXES.relay}${nanoid()}`, workspaceId: GALLERY_WORKSPACE, slug, title: bp.meta.title, status: "draft",
        visibility: "gallery", flagship, draft: bp as unknown as Json, draftRev: 0, lint, origin: "seed",
        createdAt: now, updatedAt: now, lastUsedAt: now,
      })
      .returning();
  }
  const relayId = row!.id;
  const seedModeration = { flagged: false, categories: [], checkedAt: now.toISOString(), source: "seed" };

  // the gallery version
  const hash = kernel.hash(bp);
  let [base] = await tx
    .select({ id: relayVersions.id, preset: relayVersions.preset })
    .from(relayVersions)
    .where(and(eq(relayVersions.relayId, relayId), eq(relayVersions.blueprintHash, hash)));
  if (!base) {
    const version = await nextVersion(tx, relayId);
    base = { id: `${ID_PREFIXES.version}${nanoid()}`, preset: null };
    await tx.insert(relayVersions).values({
      id: base.id, relayId, version, blueprint: bp as unknown as Json, blueprintHash: hash, kernelVersion: kernel.kernelVersion,
      moderation: seedModeration, createdAt: now,
    });
    created++;
  } else if (base.preset) {
    throw new Error("the gallery blueprint equals one of its own presets");
  }

  // the relay row follows the file (only when something changed, so a second boot writes nothing)
  const changed =
    row!.currentVersionId !== base.id || row!.title !== bp.meta.title || row!.flagship !== flagship ||
    row!.visibility !== "gallery" || row!.deletedAt !== null || row!.status === "archived" ||
    canonicalJson(row!.draft) !== canonicalJson(bp) || canonicalJson(row!.lint) !== canonicalJson(lint);
  if (changed) {
    await tx
      .update(relays)
      .set({
        currentVersionId: base.id, title: bp.meta.title, flagship, visibility: "gallery", deletedAt: null, status: "draft",
        draft: bp as unknown as Json, lint, updatedAt: now,
        ...(canonicalJson(row!.draft) !== canonicalJson(bp) ? { draftRev: sql`${relays.draftRev} + 1` } : {}),
      })
      .where(eq(relays.id, relayId));
  }

  // the "Try an edit" presets of this version
  for (const preset of entry.presets) {
    let patched: unknown;
    try {
      patched = applyJsonPatch(bp, preset.patch);
    } catch (e) {
      errors.push(`${entry.file} preset ${preset.id}: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    const pp = kernel.parse(patched);
    if (!pp.blueprint) {
      errors.push(`${entry.file} preset ${preset.id}: the patched blueprint does not match BlueprintSchema (${pp.issues[0]?.message ?? ""})`);
      continue;
    }
    const pHash = kernel.hash(pp.blueprint);
    const meta = { id: preset.id, label: preset.label, baseVersionId: base.id };
    const [existing] = await tx
      .select({ id: relayVersions.id, preset: relayVersions.preset })
      .from(relayVersions)
      .where(and(eq(relayVersions.relayId, relayId), eq(relayVersions.blueprintHash, pHash)));
    if (existing) {
      if (!existing.preset) {
        errors.push(`${entry.file} preset ${preset.id}: equals a non-preset version of the relay`);
        continue;
      }
      const cur = VersionPresetSchema.safeParse(existing.preset);
      if (!cur.success || canonicalJson(cur.data) !== canonicalJson(meta)) {
        await tx.update(relayVersions).set({ preset: meta }).where(eq(relayVersions.id, existing.id));
      }
      continue;
    }
    await tx.insert(relayVersions).values({
      id: `${ID_PREFIXES.version}${nanoid()}`, relayId, version: await nextVersion(tx, relayId), blueprint: pp.blueprint as unknown as Json,
      blueprintHash: pHash, kernelVersion: kernel.kernelVersion, moderation: seedModeration, preset: meta, createdAt: now,
    });
    created++;
  }
  return created;
}

async function nextVersion(tx: Tx, relayId: string): Promise<number> {
  const [m] = await tx
    .select({ v: sql<number>`coalesce(max(${relayVersions.version}), 0)::int`.mapWith(Number) })
    .from(relayVersions)
    .where(eq(relayVersions.relayId, relayId));
  return (m?.v ?? 0) + 1;
}
