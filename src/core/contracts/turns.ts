/**
 * contracts/turns.ts - a finalized STT turn as the client sends it to /api/extract (DESIGN §4.1). Frozen at G0.
 */
import { z } from "zod";
import { ChannelSchema } from "./case";

export const WordTimingSchema = z.object({
  text: z.string(),
  startMs: z.number(),
  endMs: z.number(),
  confidence: z.number(),
});
export type WordTiming = z.infer<typeof WordTimingSchema>;

export const TURN_SOURCES = ["stt_live", "stt_cache", "typed", "mic"] as const;
export const TurnSourceSchema = z.enum(TURN_SOURCES);
export type TurnSource = z.infer<typeof TurnSourceSchema>;

/**
 * Turn ids: the only sanctioned formats (G0). /api/extract is idempotent on (caseId, turnId), and `turn_order`
 * restarts at 0 in every Streaming session, so the id must say WHICH session a turn came from:
 *
 * | Source | Id | Built by |
 * |---|---|---|
 * | the channel's first LIVE session of the run | `${ch}-${turn_order}` | `turnIdOf(ch, order)` |
 * | the channel's g-th later LIVE session (reconnect §5.1.9, hot upgrade §5.1.10), g = 1, 2, … | `${ch}-${turn_order}-r${g}` | `turnIdOf(ch, order, g)` |
 * | a CACHED turn (Express prefill §5.1.6, cached replay §5.1.10, partial-cached channels, the extraction cache §6.3) | `${ch}-c${turn_order}` | `cachedTurnIdOf(ch, order)` |
 * | a cut turn (sweep, §6.5 step 3) | `${ch}-cut-${n}` | `cutTurnIdOf(ch, n)` |
 *
 * Cached ids use the `turn_order` of the cached STT session (which started at call ms 0), so they are stable per
 * call and are the keys of `data/cache/extract/**` and of the cached fact events the server serves for
 * `(callId, turnId, pipelineVersion)`. On Express the live session after the prefill is a first live session
 * (`rep-0`, …) and cannot collide with the prefilled `rep-cN`. `TurnInputSchema` enforces the format, that the id's
 * channel equals `channel`, and that cached ids ⇔ `source: "stt_cache"`.
 */
export const TURN_ID_RE = /^(rep|customer)-(?:(\d+)(?:-r([1-9]\d*))?|c(\d+)|cut-(\d+))$/;

export const turnIdOf = (channel: "rep" | "customer", turnOrder: number, generation = 0): string =>
  `${channel}-${turnOrder}${generation > 0 ? `-r${generation}` : ""}`;
export const cachedTurnIdOf = (channel: "rep" | "customer", turnOrder: number): string => `${channel}-c${turnOrder}`;
export const cutTurnIdOf = (channel: "rep" | "customer", n: number): string => `${channel}-cut-${n}`;

export interface ParsedTurnId {
  channel: "rep" | "customer";
  kind: "live" | "cached" | "cut";
  /** turn_order (live/cached) or the cut counter n. */
  order: number;
  /** Live-session generation (0 for the first live session; always 0 for cached and cut ids). */
  generation: number;
}

/** Inverse of the three builders; null for anything else. */
export function parseTurnId(id: string): ParsedTurnId | null {
  const m = TURN_ID_RE.exec(id);
  if (!m) return null;
  const channel = m[1] as "rep" | "customer";
  if (m[2] !== undefined) return { channel, kind: "live", order: Number(m[2]), generation: m[3] ? Number(m[3]) : 0 };
  if (m[4] !== undefined) return { channel, kind: "cached", order: Number(m[4]), generation: 0 };
  return { channel, kind: "cut", order: Number(m[5]), generation: 0 };
}

/**
 * Client → /api/extract. All ms fields are on the call clock and MAY be fractional (callMs = srcPos/srcRate·1000 at
 * 8 kHz has 0.125 ms steps); the DB stores them as double precision, so producers never need to round (G0).
 *
 * `TurnInputBaseSchema` is the plain object (use it for `.omit/.pick`, which zod 4 refuses on refined schemas);
 * `TurnInputSchema` adds the turn-id checks and is what routes validate with.
 */
export const TurnInputBaseSchema = z.object({
  caseId: z.string().min(1),
  /** Built only with turnIdOf / cachedTurnIdOf / cutTurnIdOf above (G0 turn-id scheme). */
  turnId: z.string().min(1).max(64).regex(TURN_ID_RE, "turnId must be built with turnIdOf/cachedTurnIdOf/cutTurnIdOf"),
  channel: ChannelSchema,
  text: z.string(),
  startMs: z.number(),
  endMs: z.number(),
  words: z.array(WordTimingSchema),
  source: TurnSourceSchema,
  /** Call clock when the final arrived. */
  recvMs: z.number(),
  /** Set by the takeover protocol. */
  cut: z.boolean(),
  late: z.boolean(),
});
export const TurnInputSchema = TurnInputBaseSchema.superRefine((t, ctx) => {
  const p = parseTurnId(t.turnId);
  if (!p) return; // the regex already reported it
  if (p.channel !== t.channel) ctx.addIssue({ code: "custom", path: ["turnId"], message: `turnId channel ${p.channel} ≠ channel ${t.channel}` });
  if ((p.kind === "cached") !== (t.source === "stt_cache")) {
    ctx.addIssue({ code: "custom", path: ["turnId"], message: 'cached turn ids (`${ch}-cN`) are used exactly when source is "stt_cache"' });
  }
});
export type TurnInput = z.infer<typeof TurnInputSchema>;
