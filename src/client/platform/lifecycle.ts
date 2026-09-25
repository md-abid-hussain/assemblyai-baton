/**
 * lifecycle.ts - `PageLifecycle` (DESIGN §7.6 "iOS backgrounding"). Listens to `visibilitychange`, `freeze`,
 * `pagehide`/`pageshow` and the AudioContext's `statechange`.
 *
 * - iOS only (desktop Chrome keeps rendering audio in a background tab, so nothing pauses there):
 *   hidden / frozen / pagehide → `onPause("ios_background")`.
 * - Any platform: the context entering Safari's non-standard `"interrupted"` state (a phone call, Siri, another app
 *   taking the audio session) → `onPause("audio_interrupted")`.
 * - `onResume` fires once when the page is visible again (and not frozen) after a pause. On iOS the caller shows
 *   "Paused: tap to resume" and resumes the context inside that tap; STT reconnects via the offset path (§5.1.9).
 * Pauses are de-duplicated: one pause per resume.
 */
import "client-only";

import type { PageLifecycle } from "@/core/contracts/services";
import { detectIOS } from "./ios";

type PauseReason = "ios_background" | "audio_interrupted";

export interface LifecycleTargets {
  doc: Pick<Document, "addEventListener" | "removeEventListener"> & { readonly visibilityState: DocumentVisibilityState | string };
  win: Pick<Window, "addEventListener" | "removeEventListener">;
  /** Set later with `attachContext` when the context is created in the unlock gesture. */
  ctx?: AudioContextLike | null;
  isIOS?: boolean;
}

export interface AudioContextLike {
  readonly state: string;
  addEventListener(type: "statechange", cb: () => void): void;
  removeEventListener(type: "statechange", cb: () => void): void;
}

export class BrowserPageLifecycle implements PageLifecycle {
  readonly isIOS: boolean;
  private readonly t: LifecycleTargets;
  private readonly pauseCbs = new Set<(r: PauseReason) => void>();
  private readonly resumeCbs = new Set<() => void>();
  private paused: PauseReason | null = null;
  private frozen = false;
  private ctx: AudioContextLike | null = null;
  private readonly offs: (() => void)[] = [];
  /** Event log for the dev page / notes: [reason|"resume", performance time]. */
  readonly log: { kind: PauseReason | "resume"; at: number }[] = [];

  constructor(t: LifecycleTargets) {
    this.t = t;
    this.isIOS = t.isIOS ?? detectIOS();
    const on = <K extends string>(target: { addEventListener(k: K, cb: () => void): void; removeEventListener(k: K, cb: () => void): void }, k: K, cb: () => void) => {
      target.addEventListener(k, cb);
      this.offs.push(() => target.removeEventListener(k, cb));
    };
    on(t.doc as never, "visibilitychange", () => this.onVisibility());
    on(t.doc as never, "freeze", () => {
      this.frozen = true;
      if (this.isIOS) this.pause("ios_background");
    });
    on(t.doc as never, "resume", () => {
      this.frozen = false;
      this.maybeResume();
    });
    on(t.win as never, "pagehide", () => {
      if (this.isIOS) this.pause("ios_background");
    });
    on(t.win as never, "pageshow", () => this.maybeResume());
    if (t.ctx) this.attachContext(t.ctx);
  }

  /** Watch the (single) AudioContext once it exists. */
  attachContext(ctx: AudioContextLike): void {
    if (this.ctx === ctx) return;
    this.ctx = ctx;
    const cb = () => this.onCtxState();
    ctx.addEventListener("statechange", cb);
    this.offs.push(() => ctx.removeEventListener("statechange", cb));
  }

  get pausedReason(): PauseReason | null {
    return this.paused;
  }

  private onVisibility(): void {
    if (this.t.doc.visibilityState === "hidden") {
      if (this.isIOS) this.pause("ios_background");
    } else {
      this.maybeResume();
    }
  }

  private onCtxState(): void {
    const s = this.ctx?.state;
    if (s === "interrupted") this.pause("audio_interrupted");
    else if (s === "suspended" && this.isIOS && this.t.doc.visibilityState === "hidden") this.pause("ios_background");
    else if (s === "running") this.maybeResume();
  }

  private pause(reason: PauseReason): void {
    if (this.paused) return;
    this.paused = reason;
    this.log.push({ kind: reason, at: now() });
    for (const cb of [...this.pauseCbs]) cb(reason);
  }

  private maybeResume(): void {
    if (!this.paused) return;
    if (this.t.doc.visibilityState === "hidden" || this.frozen) return;
    if (this.paused === "audio_interrupted" && this.ctx && this.ctx.state === "interrupted") return;
    this.paused = null;
    this.log.push({ kind: "resume", at: now() });
    for (const cb of [...this.resumeCbs]) cb();
  }

  onPause(cb: (reason: PauseReason) => void): () => void {
    this.pauseCbs.add(cb);
    return () => this.pauseCbs.delete(cb);
  }

  onResume(cb: () => void): () => void {
    this.resumeCbs.add(cb);
    return () => this.resumeCbs.delete(cb);
  }

  dispose(): void {
    for (const off of this.offs.splice(0)) off();
    this.pauseCbs.clear();
    this.resumeCbs.clear();
  }
}

const now = (): number => (typeof performance !== "undefined" ? performance.now() : Date.now());

/** The page's lifecycle for the real browser globals. */
export function createPageLifecycle(opts: { isIOS?: boolean } = {}): BrowserPageLifecycle {
  return new BrowserPageLifecycle({ doc: document, win: window, ...(opts.isIOS !== undefined ? { isIOS: opts.isIOS } : {}) });
}
