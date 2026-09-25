import "server-only";

import type { CronKind } from "../../core/contracts/api";
import { getDb } from "../db/client";
import { env } from "../env";
import { runBudgetGuard } from "../jobs/budget-guard";
import { getJobRunner, getVaAuditHook, installBuiltinSteps } from "../jobs/runner";
import { getDbAuthority, getLimitsAuthority } from "../limits/index";
import { sweepRegistry } from "../registry/sweeper";
import { runFullCheck, runLightCheck } from "./synthetic";

/**
 * #26 POST /api/internal/cron?kind=light|full|purge|tick (DESIGN §4.5, §10.1 crontab):
 *  light  hourly: F5 sweep + F8 budget guard + F7 light check + the F6 audit backstop (WP8's hook, while live)
 *  full   every 6 h: F7 full check (1 STT + 1 VA session, ≈ $0.0075)
 *  purge  daily: the `purge` job (enqueued and advanced at once)
 *  tick   the Vercel mirror's replacement for the in-process worker: job tick + sweep + budget guard
 * Each part is isolated: a failing part is reported in `details` and makes `ok` false, never a 500.
 */
export async function runCron(kind: CronKind): Promise<{ ok: boolean; details: Record<string, unknown> }> {
  const details: Record<string, unknown> = {};
  let ok = true;
  const part = async (name: string, fn: () => Promise<unknown>) => {
    try {
      details[name] = await fn();
    } catch (err) {
      ok = false;
      details[name] = { error: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200) };
    }
  };
  const dbA = getDbAuthority();
  const syntheticDeps = () => ({ db: getDb(), authority: getLimitsAuthority(), flags: dbA?.flagStore ?? null, deployId: env().BATON_DEPLOY_ID });

  if (kind === "light" || kind === "tick") {
    if (dbA) {
      await part("sweep", () => sweepRegistry(dbA));
      await part("budget", async () => {
        const g = await runBudgetGuard(dbA);
        return { mode: g.flags.mode, reason: g.flags.reason, dailyCapUsd: g.dailyCapUsd, pctToday: g.pctToday, cleared: g.cleared, tripped: g.tripped };
      });
    }
  }
  if (kind === "tick") {
    await part("jobs", async () => {
      await installBuiltinSteps();
      return { ran: await getJobRunner().tick() };
    });
  }
  if (kind === "light") {
    await part("light", async () => {
      const r = await runLightCheck(syntheticDeps());
      if (!r.ok) ok = false;
      return { ok: r.ok, details: r.details };
    });
    const hook = getVaAuditHook();
    if (hook) {
      await part("vaAudit", async () => ((await getLimitsAuthority().flags()).mode === "live" ? hook() : "skipped (not live)"));
    }
  }
  if (kind === "full") {
    await part("full", async () => {
      const r = await runFullCheck(syntheticDeps());
      if (!r.ok) ok = false;
      return { ok: r.ok, details: r.details, mode: r.mode };
    });
  }
  if (kind === "purge") {
    await part("purge", async () => {
      const runner = getJobRunner();
      await installBuiltinSteps(runner);
      const id = await runner.enqueue("purge", new Date().toISOString().slice(0, 10));
      const status = await runner.advance(id);
      if (status !== "done") ok = false;
      return { jobId: id, status };
    });
  }
  return { ok, details };
}
