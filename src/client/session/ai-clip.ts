/**
 * client/session/ai-clip.ts - AI-half evidence clips (DESIGN §5.11): the agent's own recording through WP8's route #21
 * `GET /api/va-sessions/[id]/audio` (takeover token as a Bearer header → 302 to a pre-signed OGG).
 *
 * The route needs the Authorization header, so an `<audio src>` cannot call it directly: the page fetches it once per
 * VA session (the browser drops the header on the cross-origin redirect), keeps the OGG as a blob URL, and plays each
 * clip window from it. 404 + Retry-After (the recording is not ready, ≈4–7 s after the end) is retried a few times.
 * Any other failure leaves the chip silent (a warning in the log); the evidence text stays on screen.
 */
import "client-only";

import type { Evidence } from "@/core/contracts/case";

export interface AiClipAuth {
  takeoverToken: string | null;
  vaSessionId: string | null;
}

/** The part of HTMLAudioElement the player uses (a fake in tests). */
export interface ClipAudio {
  currentTime: number;
  play(): Promise<void>;
  pause(): void;
  onended: (() => void) | null;
}

export interface AiClipPlayerDeps {
  fetchImpl?: typeof fetch;
  createAudio?: (src: string) => ClipAudio;
  createObjectUrl?: (b: Blob) => string;
  sleep?: (ms: number) => Promise<void>;
  setTimeout?: (cb: () => void, ms: number) => unknown;
  clearTimeout?: (id: unknown) => void;
  log?: (level: "warn", msg: string, data?: Record<string, unknown>) => void;
  /** 404 retries while the recording is being written (default 4, Retry-After seconds apart). */
  notReadyRetries?: number;
}

export type AiClipPlayer = (ev: Evidence, w: { fromMs: number; toMs: number }, auth: AiClipAuth) => Promise<void>;

export function createAiClipPlayer(d: AiClipPlayerDeps = {}): AiClipPlayer {
  const doFetch = d.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const sleep = d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const setT = d.setTimeout ?? ((cb: () => void, ms: number) => setTimeout(cb, ms));
  const clearT = d.clearTimeout ?? ((id: unknown) => clearTimeout(id as ReturnType<typeof setTimeout>));
  const sources = new Map<string, Promise<string>>();
  let playing: { el: ClipAudio; done: () => void } | null = null;

  async function load(vaSessionId: string, token: string): Promise<string> {
    const url = `/api/va-sessions/${encodeURIComponent(vaSessionId)}/audio`;
    for (let attempt = 0; ; attempt++) {
      const r = await doFetch(url, { headers: { authorization: `Bearer ${token}` }, cache: "no-store" });
      if (r.ok) {
        const blob = await r.blob();
        return (d.createObjectUrl ?? ((b: Blob) => URL.createObjectURL(b)))(blob);
      }
      if (r.status === 404 && r.headers.get("retry-after") && attempt < (d.notReadyRetries ?? 4)) {
        await sleep(Math.max(1, Number(r.headers.get("retry-after")) || 3) * 1000);
        continue;
      }
      throw new Error(`recording unavailable (${r.status})`);
    }
  }

  return async function playAiClip(ev, w, auth) {
    const { vaSessionId, takeoverToken } = auth;
    if (!vaSessionId || !takeoverToken) return;
    let src = sources.get(vaSessionId);
    if (!src) {
      src = load(vaSessionId, takeoverToken);
      sources.set(vaSessionId, src);
      src.catch(() => sources.delete(vaSessionId)); // a later click tries again
    }
    let blobUrl: string;
    try {
      blobUrl = await src;
    } catch (e) {
      d.log?.("warn", "AI evidence clip unavailable", { error: e instanceof Error ? e.message : String(e), channel: ev.channel });
      return;
    }
    playing?.done(); // one clip at a time: a new chip click replaces the previous clip
    const el = (d.createAudio ?? ((s: string) => new Audio(s) as ClipAudio))(blobUrl);
    el.currentTime = Math.max(0, w.fromMs) / 1000;
    await new Promise<void>((resolve) => {
      let timer: unknown = null;
      const done = () => {
        if (timer !== null) clearT(timer);
        el.onended = null;
        el.pause();
        if (playing?.el === el) playing = null;
        resolve();
      };
      playing = { el, done };
      el.onended = done;
      el.play().then(
        () => (timer = setT(done, Math.max(0, w.toMs - w.fromMs))),
        (e: unknown) => {
          d.log?.("warn", "AI evidence clip did not play", { error: e instanceof Error ? e.message : String(e) });
          done();
        },
      );
    });
  };
}
