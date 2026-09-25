/**
 * evidence/clip.ts - evidence chip clip padding (DESIGN §5.11).
 *
 * Streaming words (human half): the first word of a turn starts ≈990 ms early and the last word ends 0.24–1.3 s
 * late (10b ST-6), so pad only the inner edges. Async words (AI half) are 80 ms quantized: pad 300 ms both sides.
 * Then clamp to [0, duration], enforce ≥ 1500 ms (extending both sides equally) and cap at 8000 ms (keep the start).
 */
import type { Evidence } from "../contracts/case";
import type { WordTiming } from "../contracts/turns";

export const CLIP_MIN_MS = 1500;
export const CLIP_MAX_MS = 8000;
export const STREAM_PAD_BEFORE_MS = 400;
export const STREAM_PAD_AFTER_MS = 300;
export const ASYNC_PAD_MS = 300;

export function clipWindow(
  ev: Pick<Evidence, "startMs" | "endMs">,
  turn: { words: readonly Pick<WordTiming, "startMs" | "endMs">[]; startMs: number; endMs: number },
  kind: "stream" | "async",
  durationMs: number,
): { fromMs: number; toMs: number } {
  let from: number;
  let to: number;
  if (kind === "stream") {
    const first = turn.words[0]?.startMs ?? turn.startMs;
    const last = turn.words.at(-1)?.endMs ?? turn.endMs;
    from = ev.startMs - (ev.startMs <= first ? 0 : STREAM_PAD_BEFORE_MS);
    to = ev.endMs + (ev.endMs >= last ? 0 : STREAM_PAD_AFTER_MS);
  } else {
    from = ev.startMs - ASYNC_PAD_MS;
    to = ev.endMs + ASYNC_PAD_MS;
  }
  const dur = Math.max(0, durationMs);
  from = Math.max(0, Math.min(from, dur));
  to = Math.max(from, Math.min(to, dur));
  if (to - from < CLIP_MIN_MS) {
    const grow = (CLIP_MIN_MS - (to - from)) / 2;
    from -= grow;
    to += grow;
    if (from < 0) { to -= from; from = 0; }
    if (to > dur) { from = Math.max(0, from - (to - dur)); to = dur; }
  }
  if (to - from > CLIP_MAX_MS) to = from + CLIP_MAX_MS;
  return { fromMs: from, toMs: to };
}
