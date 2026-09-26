import "server-only";

/**
 * server/publish/index.ts - WP18's publish module (PLATFORM §8; TASKS-v2 §6 WP18 T1, TASKS-v3 §7 WP18·1).
 *
 * `installPublishing()` is the one call the integrator (or a test) makes: it registers the `livePublications` counter
 * the v3 `Entitlements` default reads (SAAS §4.2 — "register a count source with `setOrgCounter`, rather than reaching
 * for the DB inside a limit check"), so the guest plan's 1 live publication is enforced before WP21 exists.
 *
 * WP14b binds `PublicationLookup` with `setRelaysDeps({ publications: publicationLookup() })`, which is what fills
 * `RelayDetail.publication` (docs/notes/requests/wp18-to-wp14b.md).
 */
import { and, eq, inArray, isNull, sql } from "drizzle-orm";

import type { PublicationView } from "../../core/contracts/v2";
import { relayPublications, relays } from "../db/schema";
import { setOrgCounter } from "../saas/ports";
import { getPublishDeps } from "./deps";
import { PgPublisher } from "./service";

export { PUBLISH_LIMITS, PgPublisher, actorOf, createAgentError, statusOf, type PublishActor, type PublicationJoin } from "./service";
export { PublishGateway, argsHashOf, type GatewayAnswer } from "./gateway";
export { readPublishedRunState, eventsFrom, stageSeqOf } from "./state";
export { buildPublishDeps, getPublishDeps, setPublishDeps, type PublishDeps, type PublishDepsOverrides } from "./deps";
export {
  PUBLISHED_NEXT_STEP_RULE, PUBLISHED_TRANSCRIPTION_MODE, publishedAgentDefinition, publishedSystemPrompt,
  publishedToolList, redactPublishedConfig, withPublishedRules, httpToolFor, firstStage, runtimeStages,
} from "./config";
export { hashPublicationKey, newPublicationKey, publicationKeyMatches, shareSlugFor } from "./keys";
export { hasPublicationOrgColumn, resetPublicationOrgColumnCache, writePublicationOrg } from "./org";

/** The `PublicationLookup` WP14b's registry takes (`RelayDetail.publication`). */
export const publicationLookup = (): { forRelay(relayId: string): Promise<PublicationView | null> } => ({
  forRelay: (relayId) => new PgPublisher(getPublishDeps()).forRelay(relayId),
});

/** Live publications of an org (the `livePublications` plan limit, SAAS §4.1). The relay join is org_id-independent. */
export async function countLivePublications(orgId: string): Promise<number> {
  const d = getPublishDeps();
  const [r] = await d.db
    .select({ n: sql<number>`count(*)::int`.mapWith(Number) })
    .from(relayPublications)
    .innerJoin(relays, eq(relays.id, relayPublications.relayId))
    .where(and(eq(relays.workspaceId, orgId), isNull(relayPublications.deletedAt), inArray(relayPublications.status, ["creating", "live"])));
  return r?.n ?? 0;
}

/** Register WP18's count source with the v3 entitlements registry. Idempotent; safe to call at every start-up. */
export function installPublishing(): void {
  setOrgCounter("livePublications", (orgId) => countLivePublications(orgId));
}

/**
 * One publication purge pass for WP12's purge job (PLATFORM §8.4, SAAS §4.1): retry pending agent deletions, then
 * unpublish publications idle past their plan's `publicationIdleHours`. Pinned publications never expire.
 */
export const runPublicationPurge = (): Promise<{ retried: number; expired: number; failed: number }> =>
  new PgPublisher(getPublishDeps()).purge();
