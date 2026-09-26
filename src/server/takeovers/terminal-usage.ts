import "server-only";

/**
 * The terminal transition's SaaS half (SAAS §4.5, §7 `run.completed`). WP14b·4.
 *
 * When a takeover reaches a terminal state, three things must be true together or not at all: the row is ended,
 * the `run.completed` domain event exists, and the usage rows (`live_run`, `ai_minutes`) exist. So this runs
 * **inside `store.end`'s transaction**, guarded by its `first` flag — a replayed `POST /api/takeovers/:id/end`
 * updates nothing and therefore emits nothing.
 *
 * Belt and braces on top of that: every write carries a deterministic idempotency key derived from the takeover
 * id (`live_run:<id>`, `ai_minutes:<id>`, the event's `dedupeKey`), so even a transition replayed from a different
 * container — or by a future retry that does not have `first` — collapses onto the same rows. "Idempotent on a
 * replayed terminal transition" is the acceptance line, and it is cheaper to make it true twice than to argue
 * about which guard held.
 *
 * **Nothing here may fail the takeover.** A demo must not lose its end because a metering row could not be
 * written, so the whole block is caught and logged. The takeover's own state is the source of truth; usage is
 * derived and can be rebuilt.
 */
import type { PaymentStatus } from "../../core/contracts/case";
import type { UsageSource } from "../../core/contracts/v3/usage";
import type { TakeoverOutcome } from "../../core/contracts/takeover";
import { log } from "../log";
import { getDomainEvents, getUsageMeter } from "../saas/ports";

const usageLog = log.child({ component: "takeover-usage" });

/** What the end transaction knows about the run it is closing. */
export interface TerminalRun {
  takeoverId: string;
  caseId: string;
  orgId: string | null;
  relayId: string | null;
  relayVersion: number | null;
  /** `simulated` for a sim take, `replay` for a labelled replay, else `recorded` (SAAS §4.5 vocabulary). */
  source: UsageSource;
  outcome: TakeoverOutcome;
  stagesReached: string[];
  aiSeconds: number;
  paymentStatus: PaymentStatus;
  startedAt: Date;
  passedAt: Date | null;
  endedAt: Date;
}

/** `<APP_URL>/app/runs/<id>` and the public API's URL for the same run; relative when `APP_URL` is unset. */
export function runLinks(takeoverId: string, appUrl: string | undefined = process.env.APP_URL): { run: string; api: string } {
  const base = appUrl?.trim().replace(/\/+$/, "") ?? "";
  return { run: `${base}/app/runs/${takeoverId}`, api: `${base}/api/v1/runs/${takeoverId}` };
}

/**
 * Minutes are billed only for the sources that cost money: a simulated take and a labelled replay are recorded at
 * quantity 0, so a run stays countable in the usage view without ever being billed (P§9, §4.5). This is the same
 * rule the ledger already applies to spend, restated where the meter can see it.
 */
export function billableMinutes(source: UsageSource, aiSeconds: number): number {
  if (source === "simulated" || source === "replay") return 0;
  return Math.max(0, aiSeconds) / 60;
}

/**
 * Emit `run.completed` and record the run's usage, in the caller's transaction.
 *
 * `orgId` is null on a device-only run under `TENANCY_MODE=legacy` before the case was stamped with an org — there
 * is no tenant to bill or notify, so nothing is written. That is the correct answer, not a dropped event: the v2
 * demo path has no org and never had one.
 */
export async function recordTerminalRun(run: TerminalRun, tx?: unknown): Promise<void> {
  if (!run.orgId) return;
  const orgId = run.orgId;
  try {
    await getDomainEvents().emit(
      {
        orgId,
        type: "run.completed",
        dedupeKey: `run.completed:${run.takeoverId}`,
        data: {
          run_id: run.takeoverId,
          relay_id: run.relayId,
          relay_version: run.relayVersion,
          source: run.source,
          outcome: run.outcome,
          stages_reached: run.stagesReached,
          ai_seconds: run.aiSeconds,
          payment_status: run.paymentStatus,
          started_at: run.startedAt.toISOString(),
          passed_at: run.passedAt?.toISOString() ?? null,
          ended_at: run.endedAt.toISOString(),
          links: runLinks(run.takeoverId),
        },
      },
      tx,
    );

    const occurredAt = run.endedAt.toISOString();
    await getUsageMeter().record(
      {
        orgId,
        kind: "live_run",
        quantity: 1,
        caseId: run.caseId,
        ...(run.relayId ? { relayId: run.relayId } : {}),
        source: run.source,
        idempotencyKey: `live_run:${run.takeoverId}`,
        occurredAt,
      },
      tx,
    );
    await getUsageMeter().record(
      {
        orgId,
        kind: "ai_minutes",
        quantity: billableMinutes(run.source, run.aiSeconds),
        caseId: run.caseId,
        ...(run.relayId ? { relayId: run.relayId } : {}),
        source: run.source,
        idempotencyKey: `ai_minutes:${run.takeoverId}`,
        occurredAt,
      },
      tx,
    );
  } catch (err) {
    usageLog.warn("run.completed / usage not recorded; the takeover is unaffected", { takeoverId: run.takeoverId, err });
  }
}
