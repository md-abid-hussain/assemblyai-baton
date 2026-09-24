/**
 * client/session/evidence.ts - evidence chip playback (DESIGN §5.11, TASKS WP7 acceptance 3).
 *
 * Human half, Watch mode: `CallPlayback.playSpan(channel, fromMs, toMs)` with the §5.11 padded window, the call ducked
 * to 20% while the clip plays (the STT feed reads source bytes, not the mix, so it is unaffected), then restored.
 * AI-half evidence (VA clock) plays from the agent recording via an <audio> element (injected `playAiClip`).
 */
import "client-only";

import type { Evidence } from "@/core/contracts/case";
import type { CallPlayback } from "@/core/contracts/services";
import type { TurnInput } from "@/core/contracts/turns";

import { clipWindow } from "./clip-window";

export const DUCK_LEVEL = 0.2;

export function clipWindowFor(ev: Evidence, turn: Pick<TurnInput, "words" | "startMs" | "endMs"> | null, durationMs: number): { fromMs: number; toMs: number } {
  const async = ev.source === "async_ch1" || ev.source === "async_ch2";
  const t = turn ?? { words: [], startMs: ev.startMs, endMs: ev.endMs };
  return clipWindow(ev, t, async ? "async" : "stream", durationMs);
}

export interface EvidencePlaybackDeps {
  playback: Pick<CallPlayback, "playSpan" | "duck"> | null;
  durationMs: number;
  turnOf(turnId: string): Pick<TurnInput, "words" | "startMs" | "endMs"> | null;
  /** AI half: plays `GET /api/va-sessions/[id]/audio#t=from,to` (WP8 route); resolves when done. */
  playAiClip?: (ev: Evidence, w: { fromMs: number; toMs: number }) => Promise<void>;
}

/** Serialises clips: a new chip click stops waiting on the previous one (the player replaces its one-shot source). */
export function createEvidencePlayer(d: EvidencePlaybackDeps) {
  let current = 0;
  return async function playEvidence(ev: Evidence): Promise<{ fromMs: number; toMs: number } | null> {
    const my = ++current;
    const w = clipWindowFor(ev, d.turnOf(ev.turnId), d.durationMs);
    if (ev.channel === "ai" || ev.channel === "customer_ai") {
      if (!d.playAiClip) return null;
      await d.playAiClip(ev, w);
      return w;
    }
    if (!d.playback) return null;
    d.playback.duck(DUCK_LEVEL);
    try {
      await d.playback.playSpan(ev.channel, w.fromMs, w.toMs);
    } finally {
      if (my === current) d.playback.duck(1);
    }
    return w;
  };
}
