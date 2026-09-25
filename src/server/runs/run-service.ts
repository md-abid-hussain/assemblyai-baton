import "server-only";

import { eq, sql } from "drizzle-orm";

import type { StartRunRequest } from "../../core/contracts/api";
import { BatonError } from "../../core/contracts/errors";
import type { RunPlan } from "../../core/contracts/run";
import type { CallManifestEntry } from "../../core/contracts/scenario";
import type { LimitsAuthority, RunService } from "../../core/contracts/services";
import { newId } from "../../lib/ids";
import type { Db } from "../db/client";
import { cases, liveSessions } from "../db/schema";
import { modeDenial } from "../flags";
import { log } from "../log";
import { sttReservationUsd, systemClock, vaReservationUsd, type Clock, type LimitsConfig } from "../limits/config";
import type { DbLimitsAuthority } from "../limits/db-authority";
import { DEFAULT_CALL_DURATION_MS, EXPRESS_LEAD_MS, getCallEntry } from "./calls";
import { loadCaseRow, saveRunPlan } from "./case-port";

/**
 * RunService (DESIGN D14, §4.4 #5a/#5b): the AI half of a run is decided ONCE, at Start.
 *  - `aiHalf:"live"`: a VA slot is held (`live_sessions` status `held`, expiring at the remaining call time + 60 s)
 *    and the VA budget (the dynamic-cap maximum, ≈ $0.53) is reserved in the same transaction;
 *  - `aiHalf:"recorded"`: the call's recorded AI session bundle plays at its own handoff point; the manual pass is
 *    disabled; `reason` says why in plain words (mode, budget, or "live AI is busy").
 *  - `sttHalf` from the mode, the STT budget and the broker ETA (> 15 s → cached, the labelled cached-turn replay
 *    starts at once). The real STT grant still happens at connect time (route #5).
 * The plan is saved on the case (`cases.run_plan`). A new Start on the same case releases the previous unused hold.
 */

export interface RunServiceDeps {
  db: Db;
  authority: LimitsAuthority;
  /** Present when this process is the authority (read-only broker ETA and ledger checks). */
  dbAuthority: DbLimitsAuthority | null;
  cfg: LimitsConfig;
  now?: Clock;
}

const runLog = log.child({ component: "runs" });

const mmss = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};

function recordedCopy(why: "busy" | "budget" | "paused", call: CallManifestEntry | null, repFirstName: string): string {
  const lead =
    why === "busy" ? "Live AI is busy right now" : why === "budget" ? "Today's live AI budget is used up" : "Live AI is paused right now";
  if (!call?.recordedAiBundle) return `${lead}, and this call has no recorded AI session: the call ends at the handoff line (see the Explorer).`;
  const at = call.handoff ? ` (${mmss(call.handoff.lineStartMs)})` : "";
  return `${lead}: you'll watch the recorded AI session at ${repFirstName}'s handoff line${at}.`;
}

export class DbRunService implements RunService {
  private readonly now: Clock;
  constructor(private readonly d: RunServiceDeps) {
    this.now = d.now ?? systemClock;
  }

  async start(i: StartRunRequest & { visitorId: string; ipKey: string }): Promise<RunPlan> {
    const c = await loadCaseRow(this.d.db, i.caseId);
    if (!c) throw new BatonError("E_NOT_FOUND", "Unknown case.");
    if (c.visitorId !== i.visitorId) throw new BatonError("E_FORBIDDEN", "This case belongs to another visitor.");
    if (c.status !== "shadowing") throw new BatonError("E_CASE_STATE", "This call has already started its AI half; reload to start a new run.");
    if (c.runPlan?.vaHoldId) await this.d.authority.release(c.runPlan.vaHoldId, "superseded_by_new_run");

    const call = await getCallEntry(c.callId ?? i.callId);
    const nowMs = this.now();
    const runId = newId();
    const startOffsetMs = i.express && call?.decisionPointMs != null ? Math.max(0, call.decisionPointMs - EXPRESS_LEAD_MS) : 0;
    const remainingMs = Math.max(30_000, (call?.durationMs ?? DEFAULT_CALL_DURATION_MS) - startOffsetMs);
    const flags = await this.d.authority.flags();
    const denial = modeDenial(flags);
    const rep = c.policy?.repFirstName || "the rep";

    // ---- STT half
    let sttHalf: RunPlan["sttHalf"] = "live";
    let sttReason: string | null = null;
    if (denial) {
      sttHalf = "cached";
      sttReason = denial.message;
    } else if (this.d.dbAuthority) {
      const peek = await this.d.dbAuthority.sttPeek(2);
      const budget = await this.d.dbAuthority.ledger.check(this.d.db, { provider: "aai_stt", estUsd: 2 * sttReservationUsd(remainingMs), env: this.d.cfg.deployId });
      if (!budget.ok) {
        sttHalf = "cached";
        sttReason = "Today's live transcription budget is used up, so the transcripts are the labelled cached replay.";
      } else if (peek.etaMs === null || peek.etaMs > this.d.cfg.sttQueueMaxWaitMs) {
        sttHalf = "cached";
        sttReason = "Live transcription is busy right now, so the transcripts are the labelled cached replay.";
      }
    }

    // ---- AI half
    let aiHalf: RunPlan["aiHalf"] = "recorded";
    let vaHoldId: string | null = null;
    let holdExpiresAt: string | null = null;
    let aiReason: string | null = null;
    if (denial) {
      aiReason = recordedCopy(denial.code === "E_BUDGET" || denial.code === "E_AAI_BALANCE" ? "budget" : "paused", call, rep);
    } else {
      const expiresAt = new Date(nowMs + remainingMs + 60_000).toISOString();
      // `caseId` is an extra the DB authority stores on the hold row (the remote/file authorities ignore it).
      const holdReq = { runId, visitorId: i.visitorId, ipKey: i.ipKey, expiresAt, estUsd: vaReservationUsd(this.d.cfg), deployId: this.d.cfg.deployId, caseId: c.id };
      const h = await this.d.authority.vaHold(holdReq);
      if (h.ok) {
        aiHalf = "live";
        vaHoldId = h.holdId;
        holdExpiresAt = expiresAt;
      } else {
        aiReason = recordedCopy(h.code === "E_VA_CAPACITY" ? "busy" : h.code === "E_MODE_REPLAY_ONLY" ? "paused" : "budget", call, rep);
      }
    }

    const plan: RunPlan = {
      runId,
      caseId: c.id,
      sttHalf,
      aiHalf,
      vaHoldId,
      holdExpiresAt,
      reason: [aiReason, sttReason].filter((s): s is string => !!s).join(" ") || null,
      recordedHandoffMs: aiHalf === "recorded" ? (call?.handoff?.lineStartMs ?? null) : null,
    };
    await saveRunPlan(this.d.db, c.id, plan, nowMs);
    runLog.info("run planned", { runId, caseId: c.id, sttHalf, aiHalf, express: i.express });
    return plan;
  }

  /** Release the run's VA hold if it is still unused (`held`); a slot already `open` belongs to a takeover. */
  async release(runId: string): Promise<void> {
    const [c] = await this.d.db
      .select({ id: cases.id, runPlan: cases.runPlan })
      .from(cases)
      .where(sql`${cases.runPlan} ->> 'runId' = ${runId}`)
      .limit(1);
    const plan = (c?.runPlan as unknown as RunPlan | null) ?? null;
    if (!plan?.vaHoldId) return;
    const [row] = await this.d.db.select({ status: liveSessions.status }).from(liveSessions).where(eq(liveSessions.id, plan.vaHoldId));
    if (row?.status === "held") await this.d.authority.release(plan.vaHoldId, "run_release");
  }

  /** The case's current run plan (route #5b checks the runId belongs to the token's case). */
  async planOf(caseId: string): Promise<RunPlan | null> {
    return (await loadCaseRow(this.d.db, caseId))?.runPlan ?? null;
  }
}
