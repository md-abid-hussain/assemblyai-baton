import "server-only";

/**
 * `RelaysReadModel` (SAAS §6.2): the relay cards on the `/app` overview.
 *
 * It is a thin, read-only view over WP14b's `PgRelayRegistry` — the Studio (WP15) owns every relay *mutation*
 * and `/app/relays` itself. Two lists are merged:
 *
 *  - the org's own relays (`relays.workspace_id = orgId`, which the claim rewrites in place, SAAS §2.6 step 2);
 *  - the relays **pinned** into the org. Baton is pinned, not cloned, for guest and personal orgs (SAAS §3.3
 *    step 5), so it shows as "Flagship · read-only" at the top rather than as something the org can edit.
 *
 * Until WP19's `org_meta.pinned_relay_ids` exists, the pin set is the flagship entries of the gallery, which is
 * exactly what §3.3 step 5 pins. `pinnedIds` lets WP19/WP20·2 pass the real set without changing callers.
 */
import type { RelaySummary } from "../../core/contracts/v2";
import type { RelayCardView } from "../../core/contracts/ext/wp20-app";
import { getDb, type Db } from "../db";
import { PgRelayRegistry } from "../relays";

const cardOf = (r: RelaySummary, pinned: boolean): RelayCardView => ({
  id: r.id,
  slug: r.slug,
  title: r.title,
  industry: r.industry,
  flagship: r.flagship,
  pinned,
  versionCount: r.versionCount,
  lintErrors: r.lintErrors,
  lastRunAt: r.lastRunAt,
  updatedAt: r.updatedAt,
});

export class RelaysReadModel {
  private readonly registry: PgRelayRegistry;

  constructor(db: Db = getDb(), registry?: PgRelayRegistry) {
    this.registry = registry ?? new PgRelayRegistry({ db });
  }

  /** Pinned first, then the org's own relays, newest update first. Never throws: the overview degrades to []. */
  async listForOrg(orgId: string, pinnedIds?: readonly string[]): Promise<RelayCardView[]> {
    const [mine, gallery] = await Promise.all([
      this.registry.listMine(orgId).catch(() => [] as RelaySummary[]),
      this.registry.listGallery().catch(() => [] as RelaySummary[]),
    ]);
    const ownIds = new Set(mine.map((r) => r.id));
    const wanted = pinnedIds ? new Set(pinnedIds) : null;
    const pinned = gallery.filter((r) => (wanted ? wanted.has(r.id) : r.flagship) && !ownIds.has(r.id));
    const own = [...mine].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return [...pinned.map((r) => cardOf(r, true)), ...own.map((r) => cardOf(r, false))];
  }

  /** The org's own relays only — what the plan's `relays` count limit is measured against. */
  async countOwned(orgId: string): Promise<number> {
    return (await this.registry.listMine(orgId).catch(() => [])).length;
  }
}

export const relaysReadModel = (db?: Db): RelaysReadModel => new RelaysReadModel(db ?? getDb());
