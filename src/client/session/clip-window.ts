/**
 * client/session/clip-window.ts - evidence clip padding (DESIGN §5.11).
 *
 * G1 SHIM: WP1 owns the real `clipWindow` in src/core/evidence/clip.ts (not on this branch yet). This copy has the
 * same signature and semantics; at G1 the integrator replaces this file's body with
 *   export { clipWindow } from "@/core/evidence/clip";
 * (tests/unit/ui/evidence.test.ts keeps passing against either).
 */
import "client-only";

import type { Evidence } from "@/core/contracts/case";
import type { WordTiming } from "@/core/contracts/turns";

const CLIP_MIN_MS = 1500;
const CLIP_MAX_MS = 8000;
const STREAM_PAD_BEFORE_MS = 400;
const STREAM_PAD_AFTER_MS = 300;
const ASYNC_PAD_MS = 300;

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
    if (from < 0) {
      to -= from;
      from = 0;
    }
    if (to > dur) {
      from = Math.max(0, from - (to - dur));
      to = dur;
    }
  }
  if (to - from > CLIP_MAX_MS) to = from + CLIP_MAX_MS;
  return { fromMs: from, toMs: to };
}
