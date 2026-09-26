import "server-only";

/**
 * server/publish/state.ts - THE ONE STATE ROUTE (PLATFORM §8.3, fixed at C2):
 * `GET /api/publications/:pubId/runs/:takeoverId/state?after=<cursor>`, polled every second by a published run.
 *
 * The published client owns no state of its own: it reads the stage, the recompiled `system_prompt` and the UI events
 * of the tool calls the gateway handled from here, and on a `stageSeq` change sends
 * `session.update{system_prompt, input}` — **never `tools`**, which would replace the stored HTTP tools.
 *
 * `stageSeq` is the index of the current stage in the blueprint's stage order. Stages are forward-only (the kernel's
 * `nextStage`), so that index only ever grows, which is exactly the "increments on every stage change" the contract
 * asks for, without any extra column to keep in step.
 *
 * The in-band `next_step` in the gateway's response is the primary mechanism (P-3: 3/3, the next reply follows it
 * 0.2–0.9 s later); this poll only reinforces it, which is why the route stays a plain read.
 */
import { and, asc, eq } from "drizzle-orm";

import type { Stage } from "../../core/contracts/case";
import { PublishedCallRecordSchema } from "../../core/contracts/ext/wp18-publish";
import type { PublishedRunEvent, PublishedRunState } from "../../core/contracts/v2";
import type { Blueprint } from "../../core/contracts/v2/blueprint";
import type { AccountRecord } from "../../core/contracts/v2/blueprint";
import { cases, connectorCalls, takeovers } from "../db/schema";
import { log } from "../log";
import { firstStage, publishedSystemPrompt, PUBLISHED_TRANSCRIPTION_MODE, runtimeStages } from "./config";
import type { PublishDeps } from "./deps";
import type { PgPublisher, PublicationJoin } from "./service";

const stateLog = log.child({ component: "publish-state" });

/** `connector_calls` rows → the run's UI events. `seq` is the 1-based position of the row in the run. */
export function eventsFrom(rows: { createdAt: Date; toolName: string; status: string; result: unknown }[], after: number): PublishedRunEvent[] {
  const out: PublishedRunEvent[] = [];
  rows.forEach((r, i) => {
    const seq = i + 1;
    if (seq <= after) return;
    const parsed = PublishedCallRecordSchema.safeParse(r.result);
    out.push({
      seq,
      at: new Date(r.createdAt).toISOString(),
      tool: r.toolName,
      status: r.status,
      stage: (parsed.success ? (parsed.data.stage as Stage | null) : null) ?? null,
      ui: parsed.success ? (parsed.data.ui ?? null) : null,
    });
  });
  return out;
}

/** The stage index used as `stageSeq`: forward-only, so it never goes backwards between two polls. */
export function stageSeqOf(bp: Blueprint, stage: Stage | null): number {
  if (!stage) return 0;
  const i = runtimeStages(bp).indexOf(stage);
  return i < 0 ? 0 : i;
}

export interface RunStateInput {
  publicationId: string;
  takeoverId: string;
  after: number;
  /** The device asking. A published run's state is readable only by the visitor whose run it is. */
  visitorId: string | null;
}

export type RunStateResult =
  | { kind: "ok"; state: PublishedRunState }
  | { kind: "not_found" }
  | { kind: "forbidden" };

export async function readPublishedRunState(d: PublishDeps, publisher: PgPublisher, i: RunStateInput): Promise<RunStateResult> {
  const j = await publisher.byId(i.publicationId);
  if (!j || j.pub.deletedAt) return { kind: "not_found" };

  const [t] = await d.db
    .select({
      stage: takeovers.stage,
      outcome: takeovers.outcome,
      snapshot: takeovers.snapshot,
      caseId: takeovers.caseId,
      visitorId: cases.visitorId,
      state: cases.state,
    })
    .from(takeovers)
    .innerJoin(cases, eq(cases.id, takeovers.caseId))
    .where(eq(takeovers.id, i.takeoverId));
  if (!t) return { kind: "not_found" };
  if (i.visitorId && t.visitorId !== i.visitorId) return { kind: "forbidden" };

  const rows = await d.db
    .select({ createdAt: connectorCalls.createdAt, toolName: connectorCalls.toolName, status: connectorCalls.status, result: connectorCalls.result })
    .from(connectorCalls)
    .where(and(eq(connectorCalls.publicationId, j.pub.id), eq(connectorCalls.takeoverId, i.takeoverId)))
    .orderBy(asc(connectorCalls.createdAt));

  const events = eventsFrom(rows, i.after);
  const last = rows.length ? PublishedCallRecordSchema.safeParse(rows[rows.length - 1]!.result) : null;
  const stage = ((t.stage as Stage | null) ?? (last?.success ? (last.data.stage as Stage | null) : null) ?? firstStage(j.blueprint)) as Stage;
  const activeRun = publisher.activeRunOf(j.pub);

  return {
    kind: "ok",
    state: {
      publicationId: j.pub.id,
      takeoverId: i.takeoverId,
      stage,
      stageSeq: stageSeqOf(j.blueprint, stage),
      systemPrompt: await systemPromptFor(d, j, stage, (t.snapshot ?? t.state) as { fields?: Record<string, unknown> } | null),
      transcriptionMode: PUBLISHED_TRANSCRIPTION_MODE,
      nextStep: last?.success ? last.data.nextStep : null,
      events,
      cursor: rows.length,
      ended: !!t.outcome || activeRun !== i.takeoverId,
      activeUntil: j.pub.activeUntil ? new Date(j.pub.activeUntil).toISOString() : null,
    },
  };
}

/**
 * The prompt for this stage with the run's frozen case, compiled exactly as the published record was (same rules
 * block, same deploy marker). Null when the kernel is unavailable: the client then keeps the prompt it has, and the
 * in-band `next_step` still carries the stage change.
 */
async function systemPromptFor(
  d: PublishDeps,
  j: PublicationJoin,
  stage: Stage,
  snapshot: { fields?: Record<string, unknown> } | null,
): Promise<string | null> {
  try {
    const compiled = await d.engine.forVersion(j.versionId);
    const account = j.blueprint.context.samples[0] as AccountRecord;
    return publishedSystemPrompt({
      compiled,
      account,
      stage,
      deployId: d.deployId(),
      snapshot: { fields: snapshot?.fields ?? {} },
    });
  } catch (err) {
    stateLog.warn("could not recompile the published prompt", { publicationId: j.pub.id, err });
    return null;
  }
}
