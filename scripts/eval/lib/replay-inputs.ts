/**
 * scripts/eval/lib/replay-inputs.ts - what the extraction and verifier caches replay: the take's plan entry and the
 * cached finals of one STT variant as `TurnInput[]` (cached turn ids, call clock).
 */
import type { SttVariant } from "../../../src/core/contracts/eval";
import type { TurnInput } from "../../../src/core/contracts/turns";
import { activityFromPeaks, computePeaks } from "../../../src/core/scenario/peaks";
import { planCalls, type PlannedCall } from "../../../src/core/scenario/build";
import { isCompleteCache, monoTurnInputs, perChannelTurnInputs } from "../../../src/core/scenario/stt-cache";
import { loadKit, PILOT_SCENARIOS, readLabels, readSplit, readSttCache, takeDirOf, type PipelinePaths } from "../../calls/lib/kit-io";

/** The usable takes (plan) with their labels, from the kit + WP9 data. */
export function planFromKit(paths: PipelinePaths): PlannedCall[] {
  const kit = loadKit(paths);
  const takes = kit.sidecars.filter((s) => s.state === "downloaded").flatMap((sc) => {
    const pcm = readSplit(takeDirOf(paths, sc), sc.base);
    if (!pcm) return [];
    let labels = null;
    try {
      labels = readLabels(paths.dataRoot, sc.base);
    } catch {
      /* unreadable labels are ignored here */
    }
    return [{ sidecar: sc, durationMs: Math.round((Math.max(pcm.rep.length, pcm.customer.length) / pcm.sampleRate) * 1000), labels }];
  });
  return planCalls({ scenarios: kit.scenarios, takes }).calls;
}

export function selectCalls(calls: readonly PlannedCall[], which: string): PlannedCall[] {
  if (which === "all") return [...calls];
  if (which === "chosen") return calls.filter((c) => c.chosen);
  if (which === "pilot") return calls.filter((c) => c.chosen && PILOT_SCENARIOS.includes(c.entry.scenarioId));
  const ids = new Set(which.split(",").map((s) => s.trim()));
  return calls.filter((c) => ids.has(c.entry.callId) || ids.has(c.entry.scenarioId));
}

/** Cached finals of `variant` as TurnInputs (mono_diar: attributed with the split channels' activity), or null. */
export function cachedTurns(paths: PipelinePaths, callId: string, variant: SttVariant, caseId: string): TurnInput[] | null {
  const records = readSttCache(paths.dataRoot, callId, variant);
  if (!records || !isCompleteCache(records, variant)) return null;
  if (variant !== "mono_diar") return perChannelTurnInputs(records, caseId);
  const pcm = readSplit(paths.callsDir, callId) ?? readSplit(paths.simTakesDir, callId);
  if (!pcm) throw new Error(`${callId}: mono_diar attribution needs the split WAVs`);
  const activity = { rep: activityFromPeaks(computePeaks(pcm.rep, pcm.sampleRate)), customer: activityFromPeaks(computePeaks(pcm.customer, pcm.sampleRate)) };
  return monoTurnInputs(records, activity, caseId).turns;
}
