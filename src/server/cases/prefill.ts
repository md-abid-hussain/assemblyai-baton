import "server-only";

import type { NewFactEvent, PolicyRecord } from "../../core/contracts/case";
import type { CachedFactEvent, ExtractCacheFile } from "../../core/contracts/eval";
import type { TurnInput } from "../../core/contracts/turns";
import { cachedFinalTurns, type CaseDataSource } from "../data";
import { log } from "../log";
import type { CaseEngine } from "./engine";
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

// ============================================================================================ re-extraction (WP14b·3)

/** P§7.5: the whole Express window goes to luna in ONE call, so a preset's prefill costs one request, not one per turn. */
export const REEXTRACT_MAX_TURNS = 16;

export interface ReextractDeps {
  /** The `Extractor` port; the per-case `engine` key selects the relay's prompt, schema and spec (WP14b·3). */
  extractor: { extractTurn(i: never): Promise<{ events: NewFactEvent[]; ms: number; usd?: number; coveredTurnIds?: string[] }> };
  engine: Pick<CaseEngine, "emptyCaseState" | "extractor">;
  recordSpend?: (e: { caseId: string; usd: number; action: string }) => Promise<void>;
}

/**
 * Express on a relay whose extractor is not the one that wrote the cache (P§7.5): "Prefill uses the cached fact events
 * when the extractor `versionId` matches; otherwise (e.g. a preset or edit that adds a field) it re-extracts the
 * cached turns in one batched luna call at case creation (≈ $0.002, ≤ 5 s, shown as 'Preparing')."
 *
 * This is exactly the case the **"add a field" preset** hits: `insurance_carrier` is not in the gallery relay's
 * schema, so the committed `pc_ctx` events cannot contain it, and serving them would show the judge an empty new
 * field that the human half plainly answered. One call with every cached final as NEW TURNS fixes that; the events
 * come back under the relay's own field ids because the patch is post-processed with the relay's spec.
 *
 * It never throws and never fails the case: an upstream failure leaves the turns in the plan as `skipped`, which is
 * the same degraded state a missing cache produces, and the live half still runs.
 */
export async function reextractPrefill(
  d: ReextractDeps,
  plan: PrefillPlan,
  i: { caseId: string; policy: PolicyRecord; callDate: string },
): Promise<PrefillPlan> {
  const turns = plan.turns.slice(0, REEXTRACT_MAX_TURNS).map((t) => t.turn);
  if (!turns.length) return plan;
  const dropped = plan.turns.length - turns.length;
  if (dropped > 0) prefillLog.warn("prefill re-extraction capped", { caseId: i.caseId, dropped, cap: REEXTRACT_MAX_TURNS });
  const t0 = Date.now();
  let out: { events: NewFactEvent[]; ms: number; usd?: number; coveredTurnIds?: string[] };
  try {
    out = await d.extractor.extractTurn({
      caseId: i.caseId, policy: i.policy, callDate: i.callDate, state: d.engine.emptyCaseState(i.caseId),
      recent: [], newTurns: turns, engine: d.engine,
    } as never);
  } catch (err) {
    prefillLog.warn("prefill re-extraction failed; turns inserted without events", { caseId: i.caseId, err });
    return plan;
  }
  const covered = new Set(out.coveredTurnIds ?? turns.map((t) => t.turnId));
  const ms = out.ms || Date.now() - t0;
  prefillLog.info("prefill re-extracted", {
    caseId: i.caseId, turns: turns.length, events: out.events.length, ms: Math.round(ms), version: d.engine.extractor.version,
  });
  if (d.recordSpend && (out.usd ?? 0) > 0) {
    await d.recordSpend({ caseId: i.caseId, usd: out.usd!, action: "extract" }).catch(() => undefined);
  }
  return {
    ...plan,
    events: out.events,
    uncovered: plan.turns.map((t) => t.turn.turnId).filter((id) => !covered.has(id)),
    turns: plan.turns.map((t) =>
      covered.has(t.turn.turnId) ? { ...t, status: "done" as const, extractMs: Math.round(ms) } : { ...t, status: "skipped" as const, extractMs: null },
    ),
  };
}
