/**
 * scenario/stt-cache.ts - reading the STT cache (DESIGN §6.2) and deriving what other packages consume from it:
 *
 * - `data/cache/stt/<callId>/<variant>.jsonl`: one `SttCacheRecord` per server message, `recvMs` = audio ms sent to
 *   that session so far (= call ms: every cached session starts at call ms 0), ending with a per-channel
 *   `BatonCacheMeta` trailer (params hash, billed seconds).
 * - `public/data/cached-turns/<callId>.json` (`CachedTurnsFile`, §5.1.10): the `pc_ctx` Turn messages per channel.
 * - `TurnInput[]` for the extraction replay (§6.3): finals with cached turn ids `${ch}-c${turn_order}`.
 * - `mono_diar`: finals attributed to rep/customer by majority word speaker, speakers mapped to roles by maximum
 *   time overlap with per-channel activity of the stereo source (§6.2 "Mono attribution"). Mixing errors are kept.
 *
 * Final semantics = the live client's (`TurnTracker`, §5.1.7): the FIRST final of a `turn_order` becomes the turn;
 * later `duplicate-final`s and empty finals are ignored.
 */
import type { StreamingWord, TurnMessage } from "../aai/streaming";
import type { Channel } from "../contracts/case";
import { SttCacheRecordSchema, type CachedTurnsFile, type SttCacheRecord, type SttVariant } from "../contracts/eval";
import { STT_CACHE_META_TYPE, SttCacheMetaSchema, type SttCacheMeta } from "../contracts/ext/wp9-data";
import { cachedTurnIdOf, type TurnInput, type WordTiming } from "../contracts/turns";
import { PEAKS_PER_SEC } from "./peaks";

export type CacheChannel = SttCacheRecord["channel"];

/** Parse a JSONL cache file; throws with the line number on a malformed record. */
export function parseSttCacheJsonl(text: string, label = "stt cache"): SttCacheRecord[] {
  const out: SttCacheRecord[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line) continue;
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch {
      throw new Error(`${label}:${i + 1}: not JSON`);
    }
    const r = SttCacheRecordSchema.safeParse(json);
    if (!r.success) throw new Error(`${label}:${i + 1}: not an SttCacheRecord (${r.error.issues[0]?.message ?? "invalid"})`);
    out.push(r.data);
  }
  return out;
}

export const serializeSttCacheRecord = (r: SttCacheRecord): string => JSON.stringify(r);

const isTurn = (m: Record<string, unknown>): boolean => m["type"] === "Turn" && typeof m["turn_order"] === "number";

/** The per-channel trailer(s) of a cache file. */
export function cacheMeta(records: readonly SttCacheRecord[]): Partial<Record<CacheChannel, SttCacheMeta>> {
  const out: Partial<Record<CacheChannel, SttCacheMeta>> = {};
  for (const r of records) {
    if (r.message["type"] !== STT_CACHE_META_TYPE) continue;
    const m = SttCacheMetaSchema.safeParse(r.message);
    if (m.success) out[r.channel] = m.data;
  }
  return out;
}

/** A cache file is complete when every expected channel has its trailer (the runner writes it last). */
export function isCompleteCache(records: readonly SttCacheRecord[], variant: SttVariant): boolean {
  const meta = cacheMeta(records);
  return variant === "mono_diar" ? !!meta.mono : !!meta.rep && !!meta.customer;
}

export interface CachedFinal {
  channel: CacheChannel;
  recvMs: number;
  turn: TurnMessage;
}

/** First non-empty final per turn_order, with SpeakerRevision deltas applied (last write wins), in recvMs order. */
export function finalsOf(records: readonly SttCacheRecord[], channel: CacheChannel): CachedFinal[] {
  const finals = new Map<number, CachedFinal>();
  for (const r of records) {
    if (r.channel !== channel) continue;
    const m = r.message;
    if (isTurn(m)) {
      const t = m as unknown as TurnMessage;
      if (!t.end_of_turn) continue;
      if (!t.transcript && !(t.words?.length ?? 0)) continue; // empty final
      if (finals.has(t.turn_order)) continue; // duplicate-final
      finals.set(t.turn_order, { channel, recvMs: r.recvMs, turn: t });
    } else if (m["type"] === "SpeakerRevision" && Array.isArray(m["revisions"])) {
      for (const rev of m["revisions"] as { turn_order: number; speaker_label?: string; words?: StreamingWord[] }[]) {
        const f = finals.get(rev.turn_order);
        if (!f) continue;
        f.turn = { ...f.turn, ...(rev.speaker_label !== undefined ? { speaker_label: rev.speaker_label } : {}), words: rev.words?.length ? rev.words : f.turn.words };
      }
    }
  }
  return [...finals.values()].sort((a, b) => a.recvMs - b.recvMs || a.turn.turn_order - b.turn.turn_order);
}

const wordsOf = (t: TurnMessage): WordTiming[] =>
  (t.words ?? []).map((w) => ({ text: w.text, startMs: w.start, endMs: w.end, confidence: w.confidence }));

/** A cached final → the TurnInput the live client would have built (§5.1.7), with the cached id namespace (G0). */
export function turnInputOf(f: { channel: Channel; recvMs: number; turn: TurnMessage }, caseId: string): TurnInput {
  const words = wordsOf(f.turn);
  const startMs = words[0]?.startMs ?? f.recvMs;
  const endMs = words[words.length - 1]?.endMs ?? f.recvMs;
  return {
    caseId,
    turnId: cachedTurnIdOf(f.channel, f.turn.turn_order),
    channel: f.channel,
    text: f.turn.transcript,
    startMs,
    endMs,
    words,
    source: "stt_cache",
    recvMs: f.recvMs,
    cut: false,
    late: false,
  };
}

/** Both channels' finals as TurnInputs, merged in recvMs order (ties: endMs, then rep first). */
export function perChannelTurnInputs(records: readonly SttCacheRecord[], caseId: string): TurnInput[] {
  const all = (["rep", "customer"] as const).flatMap((ch) => finalsOf(records, ch).map((f) => turnInputOf({ ...f, channel: ch }, caseId)));
  return sortTurns(all);
}

export const sortTurns = (turns: TurnInput[]): TurnInput[] =>
  turns.sort((a, b) => a.recvMs - b.recvMs || a.endMs - b.endMs || (a.channel === b.channel ? 0 : a.channel === "rep" ? -1 : 1));

/** `public/data/cached-turns/<callId>.json` from a `pc_ctx` cache: every Turn message per channel with recvMs. */
export function cachedTurnsFileOf(callId: string, records: readonly SttCacheRecord[]): CachedTurnsFile {
  const meta = cacheMeta(records);
  const transcribedAt = meta.rep?.transcribedAt ?? meta.customer?.transcribedAt;
  if (!transcribedAt) throw new Error(`${callId}: pc_ctx cache has no BatonCacheMeta trailer (incomplete run?)`);
  const ch = (c: Channel) => records.filter((r) => r.channel === c && isTurn(r.message)).map((r) => ({ recvMs: r.recvMs, message: r.message }));
  return { callId, variant: "pc_ctx", transcribedAt, channels: { rep: ch("rep"), customer: ch("customer") } };
}

// ------------------------------------------------------------------------------------------------ mono_diar

export interface MonoAttribution {
  /** diarization speaker label → role */
  mapping: Record<string, Channel>;
  /** overlap ms per speaker × role (for the notes / debugging) */
  overlapMs: Record<string, Record<Channel, number>>;
}

/** Majority word-level speaker of a final (by word count, ties by speaking time, then label order); null if none. */
export function majoritySpeaker(t: TurnMessage): string | null {
  const count = new Map<string, { n: number; ms: number }>();
  for (const w of t.words ?? []) {
    const s = w.speaker ?? t.speaker_label;
    if (!s) continue;
    const c = count.get(s) ?? { n: 0, ms: 0 };
    c.n++;
    c.ms += Math.max(0, w.end - w.start);
    count.set(s, c);
  }
  if (!count.size && t.speaker_label) return t.speaker_label;
  let best: [string, { n: number; ms: number }] | null = null;
  for (const e of [...count.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (!best || e[1].n > best[1].n || (e[1].n === best[1].n && e[1].ms > best[1].ms)) best = e;
  }
  return best?.[0] ?? null;
}

const activeMs = (act: Uint8Array, startMs: number, endMs: number, ratePerSec: number): number => {
  const winMs = 1000 / ratePerSec;
  let ms = 0;
  const w0 = Math.max(0, Math.floor(startMs / winMs));
  const w1 = Math.min(act.length - 1, Math.floor((endMs - 1e-9) / winMs));
  for (let w = w0; w <= w1; w++) {
    if (!act[w]) continue;
    const a = Math.max(startMs, w * winMs);
    const b = Math.min(endMs, (w + 1) * winMs);
    if (b > a) ms += b - a;
  }
  return ms;
};

/**
 * Map diarization speakers to roles by maximum overlap of their words with each channel's activity. With exactly two
 * speakers the best one-to-one assignment wins; otherwise each speaker takes its own best role.
 */
export function mapSpeakersToRoles(finals: readonly CachedFinal[], activity: Record<Channel, Uint8Array>, ratePerSec = PEAKS_PER_SEC): MonoAttribution {
  const overlapMs: Record<string, Record<Channel, number>> = {};
  for (const f of finals) {
    for (const w of f.turn.words ?? []) {
      const s = w.speaker ?? f.turn.speaker_label;
      if (!s) continue;
      const o = (overlapMs[s] ??= { rep: 0, customer: 0 });
      o.rep += activeMs(activity.rep, w.start, w.end, ratePerSec);
      o.customer += activeMs(activity.customer, w.start, w.end, ratePerSec);
    }
  }
  const speakers = Object.keys(overlapMs).sort();
  const mapping: Record<string, Channel> = {};
  if (speakers.length === 2) {
    const [a, b] = speakers as [string, string];
    const straight = overlapMs[a]!.rep + overlapMs[b]!.customer;
    const crossed = overlapMs[a]!.customer + overlapMs[b]!.rep;
    mapping[a] = straight >= crossed ? "rep" : "customer";
    mapping[b] = straight >= crossed ? "customer" : "rep";
  } else {
    for (const s of speakers) mapping[s] = overlapMs[s]!.rep >= overlapMs[s]!.customer ? "rep" : "customer";
  }
  return { mapping, overlapMs };
}

/** `mono_diar` finals → TurnInputs on the attributed channel (turn ids stay unique: one session, one turn_order space). */
export function monoTurnInputs(
  records: readonly SttCacheRecord[],
  activity: Record<Channel, Uint8Array>,
  caseId: string,
  ratePerSec = PEAKS_PER_SEC,
): { turns: TurnInput[]; attribution: MonoAttribution; unattributed: number } {
  const finals = finalsOf(records, "mono");
  const attribution = mapSpeakersToRoles(finals, activity, ratePerSec);
  let unattributed = 0;
  const turns: TurnInput[] = [];
  for (const f of finals) {
    const s = majoritySpeaker(f.turn);
    let ch: Channel | undefined = s ? attribution.mapping[s] : undefined;
    if (!ch) {
      // No speaker at all: fall back to the channel that is most active during the turn.
      unattributed++;
      const w = f.turn.words ?? [];
      const start = w[0]?.start ?? f.recvMs;
      const end = w[w.length - 1]?.end ?? f.recvMs;
      ch = activeMs(activity.rep, start, end, ratePerSec) >= activeMs(activity.customer, start, end, ratePerSec) ? "rep" : "customer";
    }
    turns.push(turnInputOf({ channel: ch, recvMs: f.recvMs, turn: f.turn }, caseId));
  }
  return { turns: sortTurns(turns), attribution, unattributed };
}
