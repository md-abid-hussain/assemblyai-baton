import "server-only";

/**
 * The transactional outbox behind the `DomainEvents` port (SAAS §7.1, §14). WP19·3.
 *
 * A producer (WP14b's run completion, WP18's verifier, WP16's payments) calls
 * `getDomainEvents().emit({orgId, type, data, dedupeKey}, tx?)` **inside the transaction that made the thing
 * true**. The row lands with the change or not at all; WP24's fan-out reads `fanned_out_at is null` and delivers.
 * Nothing here talks to the network, so an outbound webhook can never slow down or fail a run.
 *
 * **Idempotence is the database's job, not the caller's.** `domain_events.dedupe_key` is unique, so a retried
 * producer inserts nothing the second time and gets `{created: false}` with the *original* event id — which is
 * what makes "at most one delivery per run" true even when a job runs twice. A `null` dedupe key is always a new
 * row (Postgres treats NULLs as distinct in a unique index), which is the right default for events that are
 * genuinely one-per-call, like `webhook.test`.
 *
 * **Events are not back-filled** (§2.6): an emit with no `orgId` is dropped, loudly in the log and quietly to the
 * caller, because a run whose case had no org has no tenant to deliver to and must not become a cross-tenant
 * delivery later.
 */
import { eq } from "drizzle-orm";

import type { DomainEventType } from "../../core/contracts/v3/events";
import type { DomainEvents } from "../../core/contracts/v3/services";
import type { Db } from "../db/client";
import { getDb } from "../db/client";
import { domainEvents } from "../db/schema-saas";
import { saasId } from "../identity/ids";
import { log } from "../log";

const outboxLog = log.child({ component: "events" });

/** The id prefix of an outbox row (SAAS §2.7). It is also the `webhook-id` header of every delivery (§7.2). */
export const EVENT_ID_PREFIX = "evt_";

type Runner = Pick<Db, "select" | "insert">;

export interface DbDomainEventsOptions {
  db?: Db;
  now?: () => number;
}

/** The real outbox. Registered through `setDomainEvents()`; no producer imports this file. */
export function createDbDomainEvents(opts: DbDomainEventsOptions = {}): DomainEvents {
  const now = opts.now ?? Date.now;
  return {
    async emit(e, tx?: unknown): Promise<{ eventId: string; created: boolean }> {
      const run: Runner = tx && typeof tx === "object" ? (tx as Runner) : (opts.db ?? getDb());
      if (!e.orgId) {
        // §2.6: not an error and not a retry — there is no tenant, so there is no event.
        outboxLog.info("event dropped: no org", { type: e.type });
        return { eventId: "", created: false };
      }
      const dedupeKey = e.dedupeKey ?? null;
      const id = saasId(EVENT_ID_PREFIX);
      const inserted = await run
        .insert(domainEvents)
        .values({
          id,
          orgId: e.orgId,
          type: e.type satisfies DomainEventType,
          payload: toPayload(e.data),
          dedupeKey,
          createdAt: new Date(now()),
        })
        .onConflictDoNothing({ target: domainEvents.dedupeKey })
        .returning({ id: domainEvents.id });

      const row = inserted[0];
      if (row) return { eventId: row.id, created: true };

      // The unique index refused it: an event with this dedupe key already exists. Return **its** id, so a retried
      // producer links to the same event rather than to nothing.
      if (dedupeKey) {
        const [existing] = await run
          .select({ id: domainEvents.id })
          .from(domainEvents)
          .where(eq(domainEvents.dedupeKey, dedupeKey))
          .limit(1);
        if (existing) return { eventId: existing.id, created: false };
      }
      outboxLog.warn("event insert did nothing and no existing row was found", { type: e.type, orgId: e.orgId });
      return { eventId: "", created: false };
    },
  };
}

/** The `payload` column is `jsonb not null`; a non-object `data` is wrapped rather than rejected. */
function toPayload(data: unknown): Record<string, unknown> {
  if (data && typeof data === "object" && !Array.isArray(data)) return data as Record<string, unknown>;
  return { value: data ?? null };
}

/** Events waiting for WP24's fan-out, oldest first. Exported so the suite can assert who can see what. */
export async function pendingEvents(
  orgId: string,
  db: Db = getDb(),
  limit = 100,
): Promise<{ id: string; type: string; dedupeKey: string | null }[]> {
  const rows = await db
    .select({ id: domainEvents.id, type: domainEvents.type, dedupeKey: domainEvents.dedupeKey })
    .from(domainEvents)
    .where(eq(domainEvents.orgId, orgId))
    .limit(limit);
  return rows;
}
