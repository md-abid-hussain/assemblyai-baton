import "server-only";

/**
 * `PgGuestSeeder` — what a brand-new guest workspace contains (SAAS §3.3 step 5, §13.1 step 4). WP14b·4.
 *
 * "Try it free · no signup" must land in a workspace that already has something in it, and it must do so inside
 * the ≤ 400 ms p50 budget of `/api/guest/start` (§3.3). So this is **DB only**: one read of the Dental gallery
 * row, one insert. No compile, no moderation call, no version snapshot, nothing external — a relay is compiled
 * the first time it is opened or run, and moderation happens at publish.
 *
 * What it seeds:
 *  - **"Dental deposit (your copy)"** — a clone of the Dental gallery relay, with secrets stripped (it is a copy
 *    of someone else's relay, exactly like the gallery clone path) and with `draft_source` set to the YAML
 *    serialization under a two-line header, so the Code tab opens on real text rather than on a generated file.
 *  - **Baton is pinned, not cloned** (§3.3 step 4, done by WP19 in the same transaction that creates the org):
 *    it is the flagship on the legacy path, shown as "Flagship · read-only". Cloning it would give every guest a
 *    private fork of the demo relay and break the pinned-publication story.
 *
 * Failure is never fatal: `guest-start.ts` catches, logs and continues with an empty workspace, because a guest
 * with no Dental copy still has Baton, the gallery and the whole judge path.
 */
import { and, eq, isNull } from "drizzle-orm";
import { nanoid } from "nanoid";

import { ID_PREFIXES, type Blueprint } from "../../core/contracts/v2";
import type { GuestSeeder } from "../../core/contracts/v3";
import { serialize } from "../../core/relay-code";
import { getDb, type Db } from "../db/client";
import { relays } from "../db/schema";
import { log } from "../log";
import { defaultRelayKernel, type RelayKernel } from "./kernel";
import { stripSecrets } from "./registry";
import { headerFor } from "./source-store";

const seedLog = log.child({ component: "guest-seeder" });

/** The gallery relay a guest org gets its own copy of, and the title that copy carries (SAAS §3.3 step 5). */
export const GUEST_TEMPLATE_SLUG = "dental-deposit";
export const GUEST_COPY_TITLE = "Dental deposit (your copy)";

/** The header comment on the seeded YAML: one human line, then the `$schema` line an IDE reads (§5.2). */
export const GUEST_SOURCE_HEADER = "Your copy of the Dental deposit template. Edit it here or in Configure.";

export interface PgGuestSeederOptions {
  db?: () => Db;
  kernel?: RelayKernel;
  now?: () => number;
  appUrl?: () => string | undefined;
  /** The gallery relay to copy. Overridable so a test can seed from a fixture relay. */
  templateSlug?: string;
  /**
   * Make sure the gallery has been seeded before the template is looked up (the relay graph's `ensureSeeded`).
   *
   * Without it the template lookup loses a race nobody can win on a **cold deployment**: `seedGallery()` runs
   * lazily on the first `GET /api/relays`, and `/api/guest/start` never lists relays, so the very first
   * visitor — the judge, or the landing CTA's background start — gets a workspace with no Dental copy and no
   * pinned Baton, while every later visitor gets both. Left out (a test with its own fixture gallery) the
   * seeder behaves exactly as before.
   */
  ensureGallery?: () => Promise<unknown>;
}

export class PgGuestSeeder implements GuestSeeder {
  private readonly db: () => Db;
  private readonly kernel: RelayKernel;
  private readonly now: () => number;
  private readonly appUrl: () => string | undefined;
  private readonly templateSlug: string;
  private readonly ensureGalleryFn: (() => Promise<unknown>) | null;

  constructor(o: PgGuestSeederOptions = {}) {
    this.db = o.db ?? (() => getDb());
    this.kernel = o.kernel ?? defaultRelayKernel;
    this.now = o.now ?? Date.now;
    this.appUrl = o.appUrl ?? (() => process.env.APP_URL);
    this.templateSlug = o.templateSlug ?? GUEST_TEMPLATE_SLUG;
    this.ensureGalleryFn = o.ensureGallery ?? null;
  }

  /**
   * Fill the gallery if this process has not yet (the relay graph's `ensureSeeded`, memoised there).
   *
   * Public because `/api/guest/start` needs it **before** it reads the flagship relay to pin (§3.3 step 5
   * happens inside the org-creating transaction, which runs before `seed()`): on a cold database that read
   * returns nothing and the first visitor's workspace has no pinned Baton. It is not on the `GuestSeeder`
   * contract, so callers feature-test it, the same way `captureVersionSource` is feature-tested in
   * `src/server/relays/saas.ts`. Never throws: an unseeded gallery is a poorer workspace, not a failed one.
   */
  async ensureGallery(orgId?: string): Promise<void> {
    if (!this.ensureGalleryFn) return;
    await this.ensureGalleryFn().catch((err: unknown) => {
      seedLog.warn("gallery seed before guest seed failed", { orgId, err });
    });
  }

  async seed(orgId: string): Promise<{ relayIds: string[] }> {
    const db = this.db();
    await this.ensureGallery(orgId);
    const [template] = await db
      .select({ draft: relays.draft })
      .from(relays)
      .where(and(eq(relays.slug, this.templateSlug), isNull(relays.deletedAt)))
      .limit(1);
    if (!template) {
      // The gallery has not been seeded in this process yet. Not an error: the org is usable, and the templates
      // section of /app still offers "Use template" once the seed has run.
      seedLog.warn("guest seed skipped: the template relay is not in the gallery yet", { orgId, slug: this.templateSlug });
      return { relayIds: [] };
    }

    const parsed = this.kernel.parse(template.draft);
    if (!parsed.blueprint) {
      seedLog.error("guest seed skipped: the template relay no longer parses", { orgId, issues: parsed.issues.length });
      return { relayIds: [] };
    }

    const draft = stripSecrets(parsed.blueprint);
    draft.meta.origin = "clone";
    draft.meta.title = GUEST_COPY_TITLE;

    const id = `${ID_PREFIXES.relay}${nanoid()}`;
    const now = new Date(this.now());
    await db.insert(relays).values({
      id,
      workspaceId: orgId,
      slug: `${this.templateSlug.slice(0, 39)}-${nanoid(6).toLowerCase()}`,
      title: GUEST_COPY_TITLE,
      visibility: "private",
      draft: draft as unknown as Record<string, unknown>,
      draftRev: 0,
      lint: this.kernel.parse(draft).issues,
      origin: "clone",
      draftSource: this.sourceFor(draft),
      draftSourceFormat: "yaml",
      createdAt: now,
      updatedAt: now,
      lastUsedAt: now,
    });
    seedLog.info("guest workspace seeded", { orgId, relayId: id });
    return { relayIds: [id] };
  }

  /** The YAML the Code tab opens on: the human line first, then the `$schema` line when `APP_URL` is set. */
  private sourceFor(draft: Blueprint): string {
    const schema = headerFor("yaml", this.appUrl()) ?? [];
    return serialize(draft, "yaml", { header: [GUEST_SOURCE_HEADER, ...schema] });
  }
}
