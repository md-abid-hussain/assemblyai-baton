import "server-only";

import type { NewFactEvent } from "../../core/contracts/case";
import type { CachedFactEvent, ExtractCacheFile } from "../../core/contracts/eval";
import type { TurnInput } from "../../core/contracts/turns";
import { cachedFinalTurns, type CaseDataSource } from "../data";
import { log } from "../log";
import type { ExtractStatus } from "./repository";

/**
 * Cached extraction (DESIGN §5.1.6 Express prefill, §5.1.10 cached replay, §6.3): the server serves the WP9 cache
 * `data/cache/extract/<callId>/v3.pc_ctx.json` for `(callId, turnId, pipelineVersion)`: deterministic, $0, no LLM.
 * A cache is served only when its `extractorVersion` equals the bound engine's (§5.3 version pinning).
 */

const prefillLog = log.child({ component: "prefill" });

/** Cached events of one turn as this case's events: id `${caseId}:${turnId}:${index}` (the same ids luna's
 *  post-processing gives, so prefill and a replay through /api/extract produce identical rows). */
export function servedEvents(caseId: string, turn: Pick<TurnInput, "turnId">, cached: readonly CachedFactEvent[]): NewFactEvent[] {
  return cached.map((e, index) => ({ ...e, id: `${caseId}:${turn.turnId}:${index}`, caseId, turnId: e.turnId ?? turn.turnId }));
}

export type CacheEntry = ExtractCacheFile["turns"][number];

export async function cacheEntryFor(
  data: CaseDataSource, callId: string | null, turnId: string, extractorVersion: string,
): Promise<CacheEntry | null> {
  if (!callId) return null;
  const file = await data.getExtractCache(callId);
  if (!file) return null;
  if (file.extractorVersion !== extractorVersion) {
    prefillLog.warn("extract cache version mismatch: not served", { callId, cache: file.extractorVersion, ours: extractorVersion });
    return null;
  }
  return file.turns.find((t) => t.turnId === turnId) ?? null;
}

export interface PrefillPlan {
  turns: { turn: TurnInput; status: ExtractStatus; extractMs: number | null }[];
  events: NewFactEvent[];
  /** Cached turns that had no cache entry (inserted as `skipped`: no LLM call in a prefill). */
  uncovered: string[];
  versionMismatch: boolean;
}

/**
 * The Express prefill: every cached final whose audio ended at or before `untilMs` (the client starts the live
 * sessions there, snapped to a turn boundary), with its cached events. 0 OpenAI calls by construction.
 */
export async function buildPrefill(
  data: CaseDataSource, i: { caseId: string; callId: string; untilMs: number; extractorVersion: string },
): Promise<PrefillPlan | null> {
  const turnsFile = await data.getCachedTurns(i.callId);
  if (!turnsFile) {
    prefillLog.warn("no cached turns for prefill", { callId: i.callId });
    return null;
  }
  const cache = await data.getExtractCache(i.callId);
  const usable = !!cache && cache.extractorVersion === i.extractorVersion;
  if (cache && !usable) prefillLog.warn("extract cache version mismatch: prefill inserts turns only", { callId: i.callId, cache: cache.extractorVersion, ours: i.extractorVersion });
  const byId = new Map((usable ? cache!.turns : []).map((t) => [t.turnId, t]));
  const plan: PrefillPlan = { turns: [], events: [], uncovered: [], versionMismatch: !!cache && !usable };
  for (const turn of cachedFinalTurns(turnsFile, i.caseId)) {
    if (turn.endMs > i.untilMs) continue;
    const entry = byId.get(turn.turnId);
    if (!entry) {
      plan.uncovered.push(turn.turnId);
      plan.turns.push({ turn, status: "skipped", extractMs: null });
      continue;
    }
    plan.turns.push({ turn, status: "done", extractMs: 0 });
    plan.events.push(...servedEvents(i.caseId, turn, entry.events));
  }
  return plan;
}
