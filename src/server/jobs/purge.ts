import "server-only";

import { and, inArray, lt } from "drizzle-orm";

import type { Db } from "../db/client";
import { getDb } from "../db/client";
import { cases, healthChecks, jobs, rateEvents, streamQueue } from "../db/schema";
import { log } from "../log";
import type { DbJobRunner } from "./runner";

/**
 * Retention purge (DESIGN §4.2, §8.3): daily (`cron purge`, 03:37 UTC on Zerops).
 *  - judge cases (`watch`, `live`) and `synthetic` cases older than 14 days, with their cascading rows (turns, fact
 *    events, verifier runs, takeovers, tool calls, payments, verifications); `spot` cases (eval evidence) are kept;
 *  - `rate_events` older than 2 days; `health_checks` older than 30 days;
 *  - housekeeping: `stream_queue` tickets older than 2 days, finished `jobs` older than 14 days.
 * The spend ledger and live-session rows are kept (reconciliation with the AssemblyAI dashboard).
 *
 * Extra steps: `registerPurgeStep(name, fn)`, e.g. WP8's "DELETE /v1/sessions/{id} for judge VA sessions older than
 * 7 days". Each step runs isolated: one failing step never blocks the others (its error is reported in details).
 */

const DAY = 86_400_000;
export type PurgeStep = (ctx: { db: Db; now: number }) => Promise<Record<string, number> | void>;

const g = globalThis as typeof globalThis & { __batonPurgeSteps?: Map<string, PurgeStep> };
const extraSteps: Map<string, PurgeStep> = (g.__batonPurgeSteps ??= new Map());

export function registerPurgeStep(name: string, fn: PurgeStep): void {
  extraSteps.set(name, fn);
}

export async function runPurge(db: Db = getDb(), now: number = Date.now()): Promise<Record<string, unknown>> {
  const at = (days: number) => new Date(now - days * DAY);
  const out: Record<string, unknown> = {};
  const cs = await db
    .delete(cases)
    .where(and(inArray(cases.mode, ["watch", "live", "synthetic"]), lt(cases.createdAt, at(14))))
    .returning({ id: cases.id });
  out.cases = cs.length;
  out.rateEvents = (await db.delete(rateEvents).where(lt(rateEvents.ts, at(2))).returning({ id: rateEvents.id })).length;
  out.healthChecks = (await db.delete(healthChecks).where(lt(healthChecks.createdAt, at(30))).returning({ id: healthChecks.id })).length;
  out.streamQueue = (await db.delete(streamQueue).where(lt(streamQueue.createdAt, at(2))).returning({ t: streamQueue.ticket })).length;
  out.jobs = (
    await db
      .delete(jobs)
      .where(and(inArray(jobs.status, ["done", "failed"]), lt(jobs.updatedAt, at(14))))
      .returning({ id: jobs.id })
  ).length;
  for (const [name, fn] of extraSteps) {
    try {
      out[name] = (await fn({ db, now })) ?? "ok";
    } catch (err) {
      out[name] = { error: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200) };
      log.child({ component: "purge" }).warn("purge step failed", { step: name, err });
    }
  }
  log.child({ component: "purge" }).info("purged", { ...out });
  return out;
}

/** The `purge` job kind: one step that runs the whole purge. */
export function registerPurgeJob(runner: DbJobRunner): void {
  runner.register("purge", async (job) => {
    const details = await runPurge();
    return { state: { ...(typeof job.state === "object" && job.state ? job.state : {}), details }, next: "done" };
  });
}
