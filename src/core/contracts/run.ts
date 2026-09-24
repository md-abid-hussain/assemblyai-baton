/**
 * contracts/run.ts - the run plan (DESIGN §4.1, D14): decided once at Start by POST /api/runs. Frozen at G0.
 */
import { z } from "zod";

export const RunPlanSchema = z.object({
  runId: z.string(),
  caseId: z.string(),
  /** "cached" when mode/budget/queue ETA > 15 s says so (it may later upgrade, §5.1.10). */
  sttHalf: z.enum(["live", "cached"]),
  /** "recorded" = the call's recordedAiBundle at its own handoff point; manual pass disabled. */
  aiHalf: z.enum(["live", "recorded"]),
  /** live_sessions row in status "held" (VA budget + slot); consumed by /api/va/token. */
  vaHoldId: z.string().nullable(),
  holdExpiresAt: z.string().nullable(),
  /** Plain-English, shown on the pre-flight card. */
  reason: z.string().nullable(),
  /** Where the recorded AI session starts (aiHalf = recorded). */
  recordedHandoffMs: z.number().nullable(),
});
export type RunPlan = z.infer<typeof RunPlanSchema>;
