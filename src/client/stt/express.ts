/**
 * express.ts - the Express start of DESIGN §5.1.6: start the recording at `max(0, decisionPointMs − 25 s)`, SNAPPED
 * BACK to a turn boundary or silence gap (so the first live partial is never half a word), and seed the customer
 * session's `agent_context` with the last cached rep final before that point (§5.2).
 *
 * The rule that matters for correctness is the PREFILL CUT: the case is created with `prefillUntilMs = startOffsetMs`
 * and the server inserts the cached finals with `recvMs ≤ prefillUntilMs`; the live sessions start at the same call
 * ms. A cached final that is IN FLIGHT at p (its first word before p, its arrival after p) would be in neither, so a
 * valid start p has no final in flight, on either channel. Candidates (all ≤ target, newest first):
 *   - joint silence gaps from `peaks.json` (both channels quiet ≥ 200 ms; the middle of the gap);
 *   - the arrival time of each cached final (everything before it on that channel is final).
 * The candidate with the fewest finals in flight (newest first) within `maxBackMs` wins; with none clean the result
 * says `unclean` + `inFlight` (a turn may be split at the cut); with no data at all the target is used unsnapped.
 */
import "client-only";

import type { CachedTurnsFile } from "@/core/contracts/eval";
import type { CallManifestEntry, Peaks } from "@/core/contracts/scenario";

export const EXPRESS_LEAD_MS = 25_000;
/** How far back from the target a clean cut may be searched. */
export const EXPRESS_MAX_BACK_MS = 15_000;

export interface ExpressStart {
  startOffsetMs: number;
  /** The last cached rep final with `recvMs ≤ startOffsetMs` (what the customer heard last; null when none). */
  seedAgentContext: string | null;
  snappedTo: "full" | "turn_boundary" | "silence" | "unclean" | "unsnapped";
  targetMs: number;
  /** Cached finals in flight at the chosen start (0 unless `silence_unclean`). */
  inFlight: number;
}

interface TurnMsg {
  type?: string;
  end_of_turn?: boolean;
  transcript?: string;
  words?: { start: number; end: number }[];
}

interface CachedFinal {
  channel: "rep" | "customer";
  firstWordMs: number;
  recvMs: number;
  text: string;
}

export function cachedFinals(file: CachedTurnsFile): CachedFinal[] {
  const out: CachedFinal[] = [];
  for (const channel of ["rep", "customer"] as const) {
    for (const r of file.channels[channel]) {
      const m = r.message as TurnMsg;
      if (m.type === "Turn" && m.end_of_turn && m.words?.length && m.transcript) {
        out.push({ channel, firstWordMs: m.words[0]!.start, recvMs: r.recvMs, text: m.transcript });
      }
    }
  }
  return out.sort((a, b) => a.recvMs - b.recvMs);
}

/** Middles of the joint silence gaps (both channels below `silencePeak` for ≥ `minGapMs`), call ms, ascending. */
export function silenceGapPoints(peaks: Peaks, silencePeak = 0.02, minGapMs = 200): number[] {
  const step = 1000 / peaks.ratePerSec;
  const n = Math.max(peaks.rep.length, peaks.customer.length);
  const out: number[] = [];
  let runStart = -1;
  for (let i = 0; i <= n; i++) {
    const quiet = i < n && (peaks.rep[i] ?? 0) < silencePeak && (peaks.customer[i] ?? 0) < silencePeak;
    if (quiet && runStart < 0) runStart = i;
    if (!quiet && runStart >= 0) {
      if ((i - runStart) * step >= minGapMs) out.push(((runStart + i) / 2) * step);
      runStart = -1;
    }
  }
  return out;
}

/** Number of cached finals in flight at p (first word before p, arrival after p). */
export function inFlightAt(finals: CachedFinal[], p: number): number {
  return finals.filter((f) => f.firstWordMs < p && f.recvMs > p).length;
}

export function lastRepFinalBefore(file: CachedTurnsFile, ms: number): string | null {
  const reps = cachedFinals(file).filter((f) => f.channel === "rep" && f.recvMs <= ms);
  return reps.at(-1)?.text ?? null;
}

export function expressStart(
  call: Pick<CallManifestEntry, "decisionPointMs">,
  cached: CachedTurnsFile | null,
  peaks: Peaks | null,
  opts: { leadMs?: number; maxBackMs?: number } = {},
): ExpressStart {
  const leadMs = opts.leadMs ?? EXPRESS_LEAD_MS;
  const maxBackMs = opts.maxBackMs ?? EXPRESS_MAX_BACK_MS;
  const full: ExpressStart = { startOffsetMs: 0, seedAgentContext: null, snappedTo: "full", targetMs: 0, inFlight: 0 };
  if (call.decisionPointMs === null) return full;
  const target = Math.max(0, call.decisionPointMs - leadMs);
  if (target === 0) return full;
  const finals = cached ? cachedFinals(cached) : [];
  const gaps = peaks ? silenceGapPoints(peaks).filter((g) => g <= target) : [];
  const boundaries = finals.map((f) => f.recvMs).filter((r) => r <= target);
  const candidates = [
    ...gaps.map((p) => ({ p, kind: "silence" as const })),
    ...boundaries.map((p) => ({ p, kind: "turn_boundary" as const })),
  ]
    .filter((c) => c.p >= target - maxBackMs)
    .sort((a, b) => b.p - a.p);
  // Fewest finals in flight wins; ties → the newest; a joint silence gap beats a bare turn boundary at equal count
  // (the gap is acoustic truth, the boundary relies on STT word times that are 0–1 s early).
  let best: { p: number; kind: "silence" | "turn_boundary"; n: number } | null = null;
  for (const c of candidates) {
    const n = cached ? inFlightAt(finals, c.p) : 0;
    if (!best || n < best.n || (n === best.n && c.kind === "silence" && best.kind !== "silence" && c.p >= best.p - 2000)) best = { ...c, n };
  }
  let p = target;
  let snappedTo: ExpressStart["snappedTo"] = "unsnapped";
  if (best) {
    p = best.p;
    snappedTo = best.n === 0 ? best.kind : "unclean";
  }
  const startOffsetMs = Math.round(p);
  return {
    startOffsetMs,
    seedAgentContext: cached ? lastRepFinalBefore(cached, startOffsetMs) : null,
    snappedTo,
    targetMs: target,
    inFlight: cached ? inFlightAt(finals, startOffsetMs) : 0,
  };
}
