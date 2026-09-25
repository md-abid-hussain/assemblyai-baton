import "server-only";

import { and, asc, desc, eq, isNotNull, isNull, ne, sql } from "drizzle-orm";
import { customAlphabet, nanoid } from "nanoid";

import { BatonError } from "../../core/contracts/errors";
import type { ModerationPurpose, RunModeration } from "../../core/contracts/ext/wp14b-engine";
import {
  RELAY_GLOBAL_CAPS, VersionModerationSchema, VersionPresetSchema, type RelayGlobalCaps, type VersionPreset,
} from "../../core/contracts/ext/wp14b-relays";
import {
  GALLERY_WORKSPACE, ID_PREFIXES, INDUSTRIES, type Blueprint, type LintIssue, type PublicationView, type RelayDetail,
  type RelayRegistry, type RelaySummary,
} from "../../core/contracts/v2";
import type { Db } from "../db/client";
import { cases, relayPublications, relays, relayVersions } from "../db/schema";
import { log } from "../log";
import { blankBlueprint } from "./blank";
import { RelayError } from "./http";
import { defaultRelayKernel, hasLintErrors, type RelayKernel } from "./kernel";
import { moderationLines, ModerationUnavailableError, type Moderator } from "./moderation";
import { seedGallery, type GallerySource, type SeedResult } from "./seed";

/**
 * `RelayRegistry` over Postgres (TASKS-v2 §5, WP14b; PLATFORM §2, §10.2).
 *
 * - Workspaces: `ws_<visitorId>` (the signed visitor cookie) or `ws_gallery`. A relay is visible to its owner, and
 *   read-only to everyone when `visibility` is `gallery` or `unlisted`. Anything else is a 404 across workspaces.
 * - `id` arguments accept the `rl_…` id or the relay slug (`/r/[slug]`; slugs never contain "_").
 * - Drafts: only `BlueprintSchema`-valid JSON is stored (else 422 E_LINT, nothing saved); `draft_rev` is optimistic.
 * - Versions are immutable and content-addressed by `blueprint_hash` (`kernel.hash`); a snapshot of an unchanged draft
 *   returns the existing version. Seeded "Try an edit" presets are versions with `preset` set (never current).
 * - `create` never blocks on the global cap: at `caps.softLive` live non-gallery relays the least-recently-used
 *   unpublished one idle for more than `caps.idleMs` is archived; above `caps.hardLive` the LRU one regardless of idle
 *   time. Archived relays disappear from lists and reads (the row and its versions stay, for runs that point at them).
 * - `last_used_at` is bumped on every owner read (at most once a minute), save, snapshot and create.
 * Per-visitor and per-ipKey quotas are the routes' job (`quotas.ts`), not the registry's.
 */

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type RelayRow = typeof relays.$inferSelect;
type Json = Record<string, unknown>;
type Industry = (typeof INDUSTRIES)[number];
type CreateFrom = Parameters<RelayRegistry["create"]>[1];
type Access = "owner" | "reader" | "none";

/** A version a run executes (`/api/cases` with `relayId`/`relayVersionId`, sims, the engine factory). */
export interface RunVersion {
  versionId: string;
  relayId: string;
  relaySlug: string;
  version: number;
  hash: string;
  blueprint: Blueprint;
  flagship: boolean;
  gallery: boolean;
  origin: RelayRow["origin"];
  preset: VersionPreset | null;
}

/** WP18 plugs its publication view in here (`Publisher`-side lookup); null until then. */
export interface PublicationLookup {
  forRelay(relayId: string): Promise<PublicationView | null>;
}

export interface PgRelayRegistryOptions {
  db: Db;
  kernel?: RelayKernel;
  now?: () => number;
  caps?: RelayGlobalCaps;
  moderator?: Moderator | null;
  publications?: PublicationLookup | null;
  gallery?: GallerySource | null;
}

const regLog = log.child({ component: "relays" });
const slugSuffix = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 8);
const TOUCH_EVERY_MS = 60_000;
/** How long the gallery's moderation lines (the pre-clear set) are cached per process. */
const GALLERY_TEXT_TTL_MS = 60_000;

const iso = (v: Date | string | null | undefined): string | null => (v == null ? null : new Date(v).toISOString());
const lintErrorsOf = (lint: unknown): number =>
  Array.isArray(lint) ? lint.filter((i) => (i as LintIssue | null)?.severity === "error").length : 0;

/** Secret references never cross workspaces: a clone into another workspace drops them (lint K2 asks to set them). */
export function stripSecrets(bp: Blueprint): Blueprint {
  const out = structuredClone(bp);
  for (const c of out.connectors) {
    if (c.type === "http_action") {
      c.headers = c.headers.map((h) => (h.value !== null && typeof h.value === "object" ? { ...h, value: null } : h));
      c.hmacSecret = null;
    } else if (c.type === "completion_webhook") {
      c.hmacSecret = null;
    }
  }
  return out;
}

export class PgRelayRegistry implements RelayRegistry {
  readonly db: Db;
  readonly kernel: RelayKernel;
  private readonly now: () => number;
  private readonly caps: RelayGlobalCaps;
  private readonly moderator: Moderator | null;
  private readonly publications: PublicationLookup | null;
  private readonly gallery: GallerySource | null;
  private galleryText: { at: number; lines: Promise<Set<string>> } | null = null;

  constructor(o: PgRelayRegistryOptions) {
    this.db = o.db;
    this.kernel = o.kernel ?? defaultRelayKernel;
    this.now = o.now ?? Date.now;
    this.caps = o.caps ?? RELAY_GLOBAL_CAPS;
    this.moderator = o.moderator ?? null;
    this.publications = o.publications ?? null;
    this.gallery = o.gallery ?? null;
  }

  // ------------------------------------------------------------------------------------------ lookups

  /** A live (not deleted, not archived) relay by id or slug, whoever owns it. */
  async findRow(idOrSlug: string): Promise<RelayRow | null> {
    if (!idOrSlug || idOrSlug.length > 80) return null;
    const col = idOrSlug.startsWith(ID_PREFIXES.relay) ? relays.id : relays.slug;
    const [row] = await this.db
      .select()
      .from(relays)
      .where(and(eq(col, idOrSlug), isNull(relays.deletedAt), ne(relays.status, "archived")))
      .limit(1);
    return row ?? null;
  }

  accessOf(row: RelayRow, ws: string): Access {
    if (row.visibility === "gallery") return "reader";
    if (row.workspaceId === ws) return "owner";
    return row.visibility === "unlisted" ? "reader" : "none";
  }

  /** The row `ws` may write: 404 when it cannot see it, 403 E_READ_ONLY when it can only read it. */
  async ownRow(idOrSlug: string, ws: string): Promise<RelayRow> {
    const row = await this.findRow(idOrSlug);
    const a = row ? this.accessOf(row, ws) : "none";
    if (!row || a === "none") throw new BatonError("E_NOT_FOUND", "No such relay.");
    if (a === "reader") {
      throw new RelayError(
        "E_READ_ONLY",
        row.visibility === "gallery" ? "Gallery relays are read-only. Clone it to edit." : "This relay belongs to another workspace. Clone it to edit.",
      );
    }
    return row;
  }

  /**
   * What a clone copies: a relay's draft (`rl_…` id or slug), or one version of it (`rv_…`, e.g. a gallery "Try an
   * edit" preset: "Keep editing" clones exactly the version the visitor ran). Null when `ws` cannot see it.
   */
  async cloneSource(ref: string, ws: string): Promise<{ row: RelayRow; json: unknown } | null> {
    if (ref.startsWith(ID_PREFIXES.version)) {
      const [v] = await this.db
        .select({ relayId: relayVersions.relayId, blueprint: relayVersions.blueprint })
        .from(relayVersions)
        .where(eq(relayVersions.id, ref));
      const row = v ? await this.findRow(v.relayId) : null;
      return row && v && this.accessOf(row, ws) !== "none" ? { row, json: v.blueprint } : null;
    }
    const row = await this.findRow(ref);
    return row && this.accessOf(row, ws) !== "none" ? { row, json: row.draft } : null;
  }

  /** Live relays of a workspace (the per-visitor "5 live relays" quota). */
  async countLive(ws: string): Promise<number> {
    const [r] = await this.db
      .select({ n: sql<number>`count(*)::int`.mapWith(Number) })
      .from(relays)
      .where(and(eq(relays.workspaceId, ws), isNull(relays.deletedAt), ne(relays.status, "archived"), ne(relays.visibility, "gallery")));
    return r?.n ?? 0;
  }

  private extrasCols() {
    // `"relays"."id"` spelled out: drizzle drops the table prefix of `${relays.id}` in single-table selects
    const outer = sql.raw(`"relays"."id"`);
    return {
      versionCount: sql<number>`(select count(*)::int from ${relayVersions} rv where rv.relay_id = ${outer} and rv.preset is null)`.mapWith(Number),
      lastRunAt: sql<Date | string | null>`(select max(c.created_at) from ${cases} c join ${relayVersions} rv2 on rv2.id = c.relay_version_id where rv2.relay_id = ${outer})`,
    };
  }

  private summaryOf(row: RelayRow, ex: { versionCount: number; lastRunAt: Date | string | null }): RelaySummary {
    const draft = row.draft as { meta?: { industry?: string } };
    return {
      id: row.id, slug: row.slug, title: row.title, industry: draft.meta?.industry ?? "other",
      visibility: row.visibility, flagship: row.flagship, origin: row.origin,
      versionCount: Number(ex.versionCount) || 0, lintErrors: lintErrorsOf(row.lint),
      lastRunAt: iso(ex.lastRunAt), updatedAt: iso(row.updatedAt)!,
    };
  }

  private async extrasOf(relayId: string): Promise<{ versionCount: number; lastRunAt: Date | string | null }> {
    const [r] = await this.db.select(this.extrasCols()).from(relays).where(eq(relays.id, relayId));
    return r ?? { versionCount: 0, lastRunAt: null };
  }

  private async presetsOf(row: RelayRow): Promise<RelayDetail["presets"]> {
    if (!row.currentVersionId) return [];
    const rows = await this.db
      .select({ id: relayVersions.id, preset: relayVersions.preset })
      .from(relayVersions)
      .where(and(eq(relayVersions.relayId, row.id), isNotNull(relayVersions.preset)))
      .orderBy(asc(relayVersions.version));
    const out: RelayDetail["presets"] = [];
    for (const r of rows) {
      const p = VersionPresetSchema.safeParse(r.preset);
      if (p.success && p.data.baseVersionId === row.currentVersionId) out.push({ id: p.data.id, label: p.data.label, versionId: r.id });
    }
    return out;
  }

  private async detailOf(row: RelayRow, ws: string, ex?: { versionCount: number; lastRunAt: Date | string | null }): Promise<RelayDetail> {
    const [extras, presets, publication] = await Promise.all([
      ex ?? this.extrasOf(row.id),
      this.presetsOf(row),
      this.publications ? this.publications.forRelay(row.id) : Promise.resolve(null),
    ]);
    return {
      ...this.summaryOf(row, extras),
      draft: row.draft as unknown as Blueprint,
      draftRev: row.draftRev,
      lint: (Array.isArray(row.lint) ? row.lint : []) as LintIssue[],
      currentVersionId: row.currentVersionId,
      publication,
      readOnly: this.accessOf(row, ws) !== "owner",
      presets,
    };
  }

  private async touch(row: RelayRow): Promise<void> {
    if (row.visibility === "gallery") return;
    const t = this.now();
    if (row.lastUsedAt && t - row.lastUsedAt.getTime() < TOUCH_EVERY_MS) return;
    await this.db.update(relays).set({ lastUsedAt: new Date(t) }).where(eq(relays.id, row.id));
  }

  // ------------------------------------------------------------------------------------------ RelayRegistry

  async listGallery(): Promise<RelaySummary[]> {
    const rows = await this.db
      .select({ r: relays, ...this.extrasCols() })
      .from(relays)
      .where(and(eq(relays.visibility, "gallery"), isNull(relays.deletedAt), ne(relays.status, "archived")))
      .orderBy(desc(relays.flagship), asc(relays.createdAt), asc(relays.slug));
    return rows.map((x) => this.summaryOf(x.r, x));
  }

  async listMine(ws: string): Promise<RelaySummary[]> {
    const rows = await this.db
      .select({ r: relays, ...this.extrasCols() })
      .from(relays)
      .where(and(eq(relays.workspaceId, ws), ne(relays.visibility, "gallery"), isNull(relays.deletedAt), ne(relays.status, "archived")))
      .orderBy(desc(relays.updatedAt));
    return rows.map((x) => this.summaryOf(x.r, x));
  }

  async get(id: string, ws: string): Promise<RelayDetail | null> {
    const row = await this.findRow(id);
    if (!row || this.accessOf(row, ws) === "none") return null;
    if (this.accessOf(row, ws) === "owner") await this.touch(row);
    return this.detailOf(row, ws);
  }

  async create(ws: string, from: CreateFrom): Promise<RelayDetail> {
    let bp: Blueprint;
    let origin: RelayRow["origin"];
    switch (from.kind) {
      case "blank": {
        if (!(INDUSTRIES as readonly string[]).includes(from.industry)) throw new BatonError("E_BAD_REQUEST", "Unknown industry.");
        bp = blankBlueprint(from.industry as Industry, new Date(this.now()).toISOString().slice(0, 10));
        origin = "user";
        break;
      }
      case "clone": {
        const src = await this.cloneSource(from.relayId, ws);
        if (!src) throw new BatonError("E_NOT_FOUND", "No such relay to clone.");
        const p = this.kernel.parse(src.json);
        if (!p.blueprint) throw new RelayError("E_LINT", "The source relay's blueprint no longer parses.", { lint: p.issues });
        bp = src.row.workspaceId === ws ? structuredClone(p.blueprint) : stripSecrets(p.blueprint);
        bp.meta.origin = "clone";
        origin = "clone";
        break;
      }
      case "blueprint": {
        const p = this.kernel.parse(from.blueprint);
        if (!p.blueprint) throw new RelayError("E_LINT", "The blueprint does not match the schema; nothing was created.", { lint: p.issues });
        bp = p.blueprint;
        origin = from.origin;
        break;
      }
    }
    const parsed = this.kernel.parse(bp);
    if (!parsed.blueprint) throw new RelayError("E_LINT", "The blueprint does not match the schema; nothing was created.", { lint: parsed.issues });
    const draft = parsed.blueprint;
    const now = new Date(this.now());
    const row = await this.db.transaction(async (tx) => {
      await this.evictForCreate(tx, now);
      const [r] = await tx
        .insert(relays)
        .values({
          id: `${ID_PREFIXES.relay}${nanoid()}`,
          workspaceId: ws,
          slug: `${draft.meta.slug.slice(0, 39)}-${slugSuffix()}`,
          title: draft.meta.title,
          visibility: "private",
          draft: draft as unknown as Json,
          draftRev: 0,
          lint: parsed.issues,
          origin,
          createdAt: now,
          updatedAt: now,
          lastUsedAt: now,
        })
        .returning();
      return r!;
    });
    return this.detailOf(row, ws, { versionCount: 0, lastRunAt: null });
  }

  async saveDraft(id: string, ws: string, blueprint: unknown, expectedRev: number): Promise<{ rev: number; lint: LintIssue[] } | { conflict: true; rev: number }> {
    const row = await this.ownRow(id, ws);
    const p = this.kernel.parse(blueprint);
    if (!p.blueprint) throw new RelayError("E_LINT", "The draft does not match the blueprint schema; it was not saved.", { lint: p.issues });
    const now = new Date(this.now());
    const [u] = await this.db
      .update(relays)
      .set({
        draft: p.blueprint as unknown as Json, draftRev: sql`${relays.draftRev} + 1`, lint: p.issues, title: p.blueprint.meta.title,
        updatedAt: now, lastUsedAt: now,
      })
      .where(and(eq(relays.id, row.id), eq(relays.draftRev, expectedRev), isNull(relays.deletedAt)))
      .returning({ rev: relays.draftRev });
    if (u) return { rev: u.rev, lint: p.issues };
    const [cur] = await this.db.select({ rev: relays.draftRev }).from(relays).where(eq(relays.id, row.id));
    return { conflict: true, rev: cur?.rev ?? row.draftRev };
  }

  async snapshotVersion(id: string): Promise<{ versionId: string; version: number; hash: string; created: boolean }> {
    return this.db.transaction(async (tx) => {
      const col = id.startsWith(ID_PREFIXES.relay) ? relays.id : relays.slug;
      const [row] = await tx.select().from(relays).where(and(eq(col, id), isNull(relays.deletedAt))).for("update");
      if (!row) throw new BatonError("E_NOT_FOUND", "No such relay.");
      const p = this.kernel.parse(row.draft);
      if (!p.blueprint) throw new RelayError("E_LINT", "The draft no longer parses; save it again first.", { lint: p.issues });
      const hash = this.kernel.hash(p.blueprint);
      const now = new Date(this.now());
      const [existing] = await tx
        .select({ id: relayVersions.id, version: relayVersions.version, preset: relayVersions.preset })
        .from(relayVersions)
        .where(and(eq(relayVersions.relayId, row.id), eq(relayVersions.blueprintHash, hash)));
      if (existing) {
        const current = !existing.preset && row.currentVersionId !== existing.id ? { currentVersionId: existing.id } : {};
        if (row.visibility !== "gallery" || Object.keys(current).length) {
          await tx.update(relays).set({ ...current, ...(row.visibility !== "gallery" ? { lastUsedAt: now } : {}) }).where(eq(relays.id, row.id));
        }
        return { versionId: existing.id, version: existing.version, hash, created: false };
      }
      const version = await this.nextVersion(tx, row.id);
      const versionId = `${ID_PREFIXES.version}${nanoid()}`;
      await tx.insert(relayVersions).values({
        id: versionId, relayId: row.id, version, blueprint: p.blueprint as unknown as Json, blueprintHash: hash,
        kernelVersion: this.kernel.kernelVersion, createdAt: now,
      });
      await tx.update(relays).set({ currentVersionId: versionId, ...(row.visibility !== "gallery" ? { lastUsedAt: now } : {}) }).where(eq(relays.id, row.id));
      return { versionId, version, hash, created: true };
    });
  }

  async nextVersion(tx: Tx | Db, relayId: string): Promise<number> {
    const [m] = await tx
      .select({ v: sql<number>`coalesce(max(${relayVersions.version}), 0)::int`.mapWith(Number) })
      .from(relayVersions)
      .where(eq(relayVersions.relayId, relayId));
    return (m?.v ?? 0) + 1;
  }

  async getVersion(versionId: string): Promise<{ relayId: string; version: number; blueprint: Blueprint; hash: string } | null> {
    if (!versionId.startsWith(ID_PREFIXES.version)) return null;
    const [v] = await this.db
      .select({ relayId: relayVersions.relayId, version: relayVersions.version, blueprint: relayVersions.blueprint, hash: relayVersions.blueprintHash })
      .from(relayVersions)
      .where(eq(relayVersions.id, versionId));
    if (!v) return null;
    const p = this.kernel.parse(v.blueprint);
    if (!p.blueprint) regLog.error("stored version no longer parses", { versionId, issues: p.issues.length });
    return { relayId: v.relayId, version: v.version, blueprint: p.blueprint ?? (v.blueprint as unknown as Blueprint), hash: v.hash };
  }

  /** `RelayRegistry.moderate` = the Publish policy: fail closed (503 E_MAINTENANCE) when the endpoint is unavailable. */
  async moderate(versionId: string): Promise<{ flagged: boolean; categories: string[] }> {
    const r = await this.moderateForRun(versionId, "publish");
    return { flagged: r.flagged, categories: r.categories };
  }

  /**
   * Moderation before a version's first Test run or Publish (PLATFORM §7.4, P14), once per version:
   * 1. the stored result, if any;
   * 2. **gallery text**: when every line of the version's author text already appears in a seeded gallery version
   *    (a clone, a preset, an edit that touched no spoken text), it is our own text: stored as `source: "seed"`, no call;
   * 3. otherwise the `Moderator` (OpenAI `omni-moderation-latest`), stored;
   * 4. endpoint unavailable: Publish fails closed (503 E_MAINTENANCE); a Test run of a gallery-derived relay (the gallery
   *    itself or a clone) fails open, unstored, so the next run asks again; anything else fails closed.
   */
  async moderateForRun(versionId: string, purpose: ModerationPurpose): Promise<RunModeration> {
    const [v] = await this.db
      .select({ blueprint: relayVersions.blueprint, moderation: relayVersions.moderation, origin: relays.origin, visibility: relays.visibility })
      .from(relayVersions)
      .innerJoin(relays, eq(relays.id, relayVersions.relayId))
      .where(eq(relayVersions.id, versionId));
    if (!v) throw new BatonError("E_NOT_FOUND", "No such relay version.");
    const cached = VersionModerationSchema.safeParse(v.moderation);
    if (cached.success) return { flagged: cached.data.flagged, categories: cached.data.categories, via: "stored" };
    const parsed = this.kernel.parse(v.blueprint);
    if (!parsed.blueprint) throw new RelayError("E_LINT", "This relay version no longer parses.", { lint: parsed.issues });
    const lines = moderationLines(parsed.blueprint);
    const gallery = await this.galleryLines();
    if (lines.every((l) => gallery.has(l))) {
      await this.storeModeration(versionId, { flagged: false, categories: [], source: "seed" });
      return { flagged: false, categories: [], via: "gallery_text" };
    }
    try {
      if (!this.moderator) throw new ModerationUnavailableError("no moderator is configured");
      const r = await this.moderator.check(lines.join("\n"), { refId: versionId });
      await this.storeModeration(versionId, { flagged: r.flagged, categories: r.categories, source: "openai" });
      return { flagged: r.flagged, categories: r.categories, via: "openai" };
    } catch (err) {
      if (!(err instanceof ModerationUnavailableError)) throw err;
      const galleryDerived = v.visibility === "gallery" || v.origin === "clone" || v.origin === "seed";
      if (purpose === "test" && galleryDerived) {
        regLog.warn("moderation unavailable; failing open for a Test run of a gallery-derived relay", { versionId });
        return { flagged: false, categories: [], via: "fail_open" };
      }
      regLog.warn("moderation unavailable; failing closed", { versionId, purpose });
      throw new BatonError("E_MAINTENANCE", "We could not check this relay's text right now. Try again in a minute.");
    }
  }

  private async storeModeration(versionId: string, r: { flagged: boolean; categories: string[]; source: "openai" | "seed" }): Promise<void> {
    const record = { flagged: r.flagged, categories: r.categories, checkedAt: new Date(this.now()).toISOString(), source: r.source };
    await this.db.update(relayVersions).set({ moderation: record }).where(and(eq(relayVersions.id, versionId), isNull(relayVersions.moderation)));
  }

  /** Every moderation line of every seeded gallery version (incl. presets), cached for a minute. */
  private galleryLines(): Promise<Set<string>> {
    const t = this.now();
    if (this.galleryText && t - this.galleryText.at < GALLERY_TEXT_TTL_MS) return this.galleryText.lines;
    const lines = (async () => {
      const rows = await this.db
        .select({ blueprint: relayVersions.blueprint })
        .from(relayVersions)
        .innerJoin(relays, eq(relays.id, relayVersions.relayId))
        .where(and(eq(relays.visibility, "gallery"), eq(relays.workspaceId, GALLERY_WORKSPACE)));
      const out = new Set<string>();
      for (const r of rows) {
        const p = this.kernel.parse(r.blueprint);
        if (p.blueprint) for (const l of moderationLines(p.blueprint)) out.add(l);
      }
      return out;
    })();
    this.galleryText = { at: t, lines };
    lines.catch(() => {
      if (this.galleryText?.lines === lines) this.galleryText = null;
    });
    return lines;
  }

  // ------------------------------------------------------------------------------------------ runs (WP14b·2)

  /** A version by id with its relay's identity, whatever the relay's status (runs of archived relays still compile). */
  async runVersion(versionId: string): Promise<RunVersion | null> {
    if (!versionId.startsWith(ID_PREFIXES.version)) return null;
    const [v] = await this.db
      .select({ v: relayVersions, r: relays })
      .from(relayVersions)
      .innerJoin(relays, eq(relays.id, relayVersions.relayId))
      .where(eq(relayVersions.id, versionId));
    if (!v) return null;
    const p = this.kernel.parse(v.v.blueprint);
    if (!p.blueprint) regLog.error("stored version no longer parses", { versionId, issues: p.issues.length });
    const preset = VersionPresetSchema.safeParse(v.v.preset);
    return {
      versionId: v.v.id, relayId: v.r.id, relaySlug: v.r.slug, version: v.v.version, hash: v.v.blueprintHash,
      blueprint: p.blueprint ?? (v.v.blueprint as unknown as Blueprint), flagship: v.r.flagship, gallery: v.r.visibility === "gallery",
      origin: v.r.origin, preset: preset.success ? preset.data : null,
    };
  }

  /**
   * The version a run in workspace `ws` executes (TASKS-v2 §5: `CreateCaseRequest` gains `relayId`/`relayVersionId`):
   * - `relayVersionId` (e.g. a gallery preset): any version of a relay `ws` can see (owner, gallery, unlisted);
   * - `relayId` only: the owner's draft is snapshotted (content-addressed, so an unchanged draft reuses its version);
   *   a reader runs the relay's current version.
   * 404 when `ws` cannot see it or there is nothing to run; 422 E_LINT when the version has lint errors.
   */
  async resolveRun(ws: string, want: { relayId?: string | undefined; relayVersionId?: string | undefined }): Promise<RunVersion> {
    let versionId: string;
    if (want.relayVersionId) {
      const [v] = want.relayVersionId.startsWith(ID_PREFIXES.version)
        ? await this.db.select({ relayId: relayVersions.relayId }).from(relayVersions).where(eq(relayVersions.id, want.relayVersionId))
        : [];
      const row = v ? await this.findRow(v.relayId) : null;
      if (!row || this.accessOf(row, ws) === "none") throw new BatonError("E_NOT_FOUND", "No such relay version.");
      if (want.relayId && want.relayId !== row.id && want.relayId !== row.slug) throw new BatonError("E_NOT_FOUND", "No such version of this relay.");
      versionId = want.relayVersionId;
    } else if (want.relayId) {
      const row = await this.findRow(want.relayId);
      const access = row ? this.accessOf(row, ws) : "none";
      if (!row || access === "none") throw new BatonError("E_NOT_FOUND", "No such relay.");
      if (access === "owner") {
        const lint = this.kernel.parse(row.draft).issues;
        if (hasLintErrors(lint)) throw new RelayError("E_LINT", "Fix the lint errors before you run this relay.", { lint });
        versionId = (await this.snapshotVersion(row.id)).versionId;
      } else {
        if (!row.currentVersionId) throw new BatonError("E_NOT_FOUND", "This relay has no saved version to run yet.");
        versionId = row.currentVersionId;
      }
    } else {
      throw new BatonError("E_BAD_REQUEST", "relayId or relayVersionId is required.");
    }
    const run = await this.runVersion(versionId);
    if (!run) throw new BatonError("E_NOT_FOUND", "No such relay version.");
    const lint = this.kernel.parse(run.blueprint).issues;
    if (hasLintErrors(lint)) throw new RelayError("E_LINT", "This relay version has lint errors, so it cannot run.", { lint });
    return run;
  }

  /**
   * The gallery version a committed gallery sim was written for (`src/generated/sim-calls.json` carries the relay slug
   * and blueprint hash, not a version id): the version with that hash, else the relay's current version.
   */
  async galleryVersionFor(slug: string, hash: string | null): Promise<string | null> {
    const [row] = await this.db
      .select({ id: relays.id, current: relays.currentVersionId })
      .from(relays)
      .where(and(eq(relays.slug, slug), eq(relays.visibility, "gallery"), isNull(relays.deletedAt)));
    if (!row) return null;
    if (hash) {
      const [v] = await this.db
        .select({ id: relayVersions.id })
        .from(relayVersions)
        .where(and(eq(relayVersions.relayId, row.id), eq(relayVersions.blueprintHash, hash)));
      if (v) return v.id;
    }
    return row.current;
  }

  async remove(id: string, ws: string): Promise<void> {
    const row = await this.ownRow(id, ws);
    const now = new Date(this.now());
    await this.db.update(relays).set({ deletedAt: now, updatedAt: now }).where(eq(relays.id, row.id));
  }

  async setVisibility(id: string, ws: string, visibility: "private" | "unlisted"): Promise<RelayDetail> {
    const row = await this.ownRow(id, ws);
    const now = new Date(this.now());
    const [u] = await this.db.update(relays).set({ visibility, updatedAt: now, lastUsedAt: now }).where(eq(relays.id, row.id)).returning();
    return this.detailOf(u!, ws);
  }

  async seedGallery(): Promise<SeedResult> {
    if (!this.gallery) return { upserted: [], versionsCreated: 0, errors: [] };
    return seedGallery({ db: this.db, kernel: this.kernel, source: this.gallery, now: this.now });
  }

  // ------------------------------------------------------------------------------------------ global cap (P§10.2)

  /** Called inside the create transaction. Serialized by an advisory lock; archives, never refuses. */
  private async evictForCreate(tx: Tx, now: Date): Promise<number> {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('relays:global-cap'))`);
    const [c] = await tx
      .select({ n: sql<number>`count(*)::int`.mapWith(Number) })
      .from(relays)
      .where(and(isNull(relays.deletedAt), ne(relays.status, "archived"), ne(relays.visibility, "gallery")));
    const live = c?.n ?? 0;
    const need = live + 1 - this.caps.softLive;
    if (need <= 0) return 0;
    let archived = await this.archiveLru(tx, need, new Date(now.getTime() - this.caps.idleMs), now);
    const hardNeed = live + 1 - archived - this.caps.hardLive;
    if (hardNeed > 0) archived += await this.archiveLru(tx, hardNeed, null, now);
    if (archived > 0) regLog.info("archived idle relays at the global cap", { archived, live, softLive: this.caps.softLive });
    return archived;
  }

  private async archiveLru(tx: Tx, limit: number, idleBefore: Date | null, now: Date): Promise<number> {
    const idle = idleBefore ? sql`and r.last_used_at < ${idleBefore.toISOString()}::timestamptz` : sql``;
    const res = await tx.execute(sql`
      update ${relays} set status = 'archived', updated_at = ${now.toISOString()}::timestamptz
      where id in (
        select r.id from ${relays} r
        where r.deleted_at is null and r.visibility <> 'gallery' and r.status not in ('archived', 'published')
          ${idle}
          and not exists (
            select 1 from ${relayPublications} p
            where p.relay_id = r.id and p.deleted_at is null and p.status in ('creating', 'live'))
        order by r.last_used_at asc
        limit ${limit}
        for update skip locked)`);
    return res.rowCount ?? 0;
  }
}

export { GALLERY_WORKSPACE };
