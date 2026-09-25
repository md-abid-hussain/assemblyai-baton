/**
 * contracts/v3/usage.ts - usage metering (SAAS §14, §4.5). WP19; frozen at C3.
 *
 * Writers call `getUsageMeter().record(u, tx?)`, which is idempotent on `idempotencyKey` (e.g. `live_run:<takeoverId>`).
 * Recorded / Simulated / Published minutes are never blended in a view (P§9); replays are recorded at quantity 0,
 * so runs stay countable but are never billed.
 */
import type { PlanId } from "./identity";

export type UsageKind = "ai_minutes" | "live_run" | "dry_run" | "voiced_sim" | "draft" | "publish";
export type UsageSource = "recorded" | "simulated" | "text_dry_run" | "published" | "replay";

export interface UsageRecord {
  orgId: string;
  kind: UsageKind;
  quantity: number;
  caseId?: string;
  relayId?: string;
  source?: UsageSource;
  idempotencyKey: string;
  occurredAt?: string;
}

export interface UsageSummary {
  orgId: string;
  period: { from: string; to: string };
  plan: PlanId;
  aiMinutes: {
    recorded: number;
    simulated: number;
    published: number;
    allowance: number;
    overageUsdEstimate: number;
  };
  today: { liveRuns: number; dryRuns: number; voicedSims: number; drafts: number };
  daily: { day: string; aiMinutes: number; runs: number }[];
}
