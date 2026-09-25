/**
 * client/session/prime.ts - the landing CTA's audio unlock (DESIGN §1.3 / App. autoplay rule, PLATFORM §12.1).
 *
 * Call `primeCallAudio()` SYNCHRONOUSLY inside the click handler of "Watch the handoff" (WP7b), then navigate
 * client-side (`<Link>` / `router.push`) to `callHref(id, { express: true })`. The page's one AudioContext is created
 * and resumed inside that click, and `/call` reuses the same engine (`getAudioEngine()` is a page singleton), so the
 * Express countdown can start playback without another tap. A full page load (a plain `<a>`, a new tab, a deep link)
 * loses the singleton: the console then shows "Tap to enable sound" after the countdown, which is the DESIGN fallback.
 */
import "client-only";

import { getAudioEngine } from "../audio/engine";

/** Returns false when the browser has no usable Web Audio (the console explains it after navigation). */
export function primeCallAudio(): boolean {
  try {
    getAudioEngine().unlockSync();
    return true;
  } catch {
    return false;
  }
}

/** The console URL for a call; `express` makes it start Express by itself after the 3 s countdown. */
export function callHref(callId: string, o: { express?: boolean } = {}): string {
  return `/call/${encodeURIComponent(callId)}${o.express ? "?express=1" : ""}`;
}
