/**
 * server/qa/purge.ts - WP8's retention step for WP2's daily purge (`registerPurgeStep("va_sessions", …)`, DESIGN §4.2,
 * §8.3): for judge takeovers (case mode watch/live/synthetic) armed more than 7 days ago, request deletion of the
 * Voice Agent session (recording, timeline) and of the async verification transcript at AssemblyAI, then mark the
 * takeover `metrics.recordingPurgedAt`. Runs a week before WP2 deletes the case rows (14 days), so the ids still
 * exist. `spot` cases (eval evidence) are kept. A 404 counts as already deleted.
 */
import "server-only";

import { and, eq, inArray, isNotNull, lt, sql } from "drizzle-orm";

import { AssemblyAIHttpError } from "../aai/async";
import type { Db } from "../db/client";
import { cases, takeovers, verifications } from "../db/schema";
import { log } from "../log";
import { wp8, type Wp8Ports } from "./deps";
import { ensureWp8Wired } from "./wiring";

export const PURGE_RECORDINGS_AFTER_DAYS = 7;
const BATCH = 200;

export async function purgeVaRecordings(ctx: { db?: Db; now?: number } = {}, ports?: Wp8Ports): Promise<Record<string, number>> {
  ensureWp8Wired();
  const p = ports ?? wp8();
  const db = ctx.db ?? p.db();
  const now = ctx.now ?? p.now();
  const cutoff = new Date(now - PURGE_RECORDINGS_AFTER_DAYS * 86_400_000);
  const rows = await db
    .select({ id: takeovers.id, sid: takeovers.vaSessionId, transcriptId: verifications.aaiTranscriptId })
    .from(takeovers)
    .innerJoin(cases, eq(cases.id, takeovers.caseId))
    .leftJoin(verifications, eq(verifications.takeoverId, takeovers.id))
    .where(
      and(
        inArray(cases.mode, ["watch", "live", "synthetic"]),
        lt(takeovers.armedAt, cutoff),
        isNotNull(takeovers.vaSessionId),
        sql`not (coalesce(${takeovers.metrics}, '{}'::jsonb) ? 'recordingPurgedAt')`,
      ),
    )
    .limit(BATCH);
  const out = { vaSessions: 0, transcripts: 0, failed: 0 };
  for (const r of rows) {
    try {
      const st = await p.vaRest().deleteSession(r.sid!);
      if (!(st >= 200 && st < 300) && st !== 404) throw new Error(`DELETE session → ${st}`);
      out.vaSessions++;
      if (r.transcriptId) {
        try {
          await p.asyncClient().delete(r.transcriptId);
        } catch (e) {
          if (!(e instanceof AssemblyAIHttpError && e.status === 404)) throw e;
        }
        out.transcripts++;
      }
      await db
        .update(takeovers)
        .set({ metrics: sql`coalesce(${takeovers.metrics}, '{}'::jsonb) || ${JSON.stringify({ recordingPurgedAt: new Date(now).toISOString() })}::jsonb` })
        .where(eq(takeovers.id, r.id));
    } catch (err) {
      out.failed++;
      log.child({ component: "purge" }).warn("recording purge failed", { takeoverId: r.id, err });
    }
  }
  return out;
}
