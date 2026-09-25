/**
 * audio-session.ts - iOS audio session control (DESIGN §7.6 "iOS silent switch"). Web Audio follows the ring/silent
 * switch on iOS unless the session is "playback". Called SYNCHRONOUSLY inside the unlock gesture:
 *   if (navigator.audioSession) navigator.audioSession.type = "playback"
 * and, for iOS versions without `audioSession`, a looping silent `<audio>` element is started in the same gesture
 * (the known unmute trick). "play-and-record" only while the mic is on, then back to "playback".
 * A muted-by-switch context still reports `running`, so nothing can detect it; the pre-flight card says so.
 */
import "client-only";

import { encodeWav } from "@/core/audio";

export type AudioSessionKind = "playback" | "play-and-record";

interface AudioSessionLike {
  type: string;
}

/** Sets `navigator.audioSession.type` when supported. Returns whether the API exists. */
export function setNavigatorAudioSession(kind: AudioSessionKind, nav: unknown = typeof navigator !== "undefined" ? navigator : undefined): boolean {
  const session = (nav as { audioSession?: AudioSessionLike } | undefined)?.audioSession;
  if (!session) return false;
  try {
    session.type = kind;
    return true;
  } catch {
    return false;
  }
}

export function hasNavigatorAudioSession(nav: unknown = typeof navigator !== "undefined" ? navigator : undefined): boolean {
  return !!(nav as { audioSession?: AudioSessionLike } | undefined)?.audioSession;
}

let silentUrl: string | null = null;
let silentEl: HTMLAudioElement | null = null;

/** A 0.5 s silent WAV as a Blob URL (CSP `media-src 'self' blob:` allows it; `data:` is not allowed). */
function silentWavUrl(): string {
  if (silentUrl) return silentUrl;
  const wav = encodeWav(new Int16Array(4000), 8000, 1);
  silentUrl = URL.createObjectURL(new Blob([wav as BlobPart], { type: "audio/wav" }));
  return silentUrl;
}

/**
 * The fallback unmute trick for iOS without `navigator.audioSession`: a looping, silent HTML media element started
 * inside the user gesture puts the page in the "playback" category. Must be called synchronously in the gesture.
 */
export function startSilentAudioLoop(doc: Document | undefined = typeof document !== "undefined" ? document : undefined): HTMLAudioElement | null {
  if (!doc) return null;
  if (silentEl) {
    void silentEl.play().catch(() => undefined);
    return silentEl;
  }
  try {
    const el = doc.createElement("audio");
    el.setAttribute("x-webkit-airplay", "deny");
    el.preload = "auto";
    el.loop = true;
    el.src = silentWavUrl();
    void el.play().catch(() => undefined);
    silentEl = el;
    return el;
  } catch {
    return null;
  }
}

export function stopSilentAudioLoop(): void {
  if (!silentEl) return;
  try {
    silentEl.pause();
  } catch {
    /* ignore */
  }
}
