/**
 * PageLifecycle (DESIGN §7.6): iOS-only background pause, audio interruption on any platform, one pause per resume,
 * iOS detection (incl. iPadOS "Macintosh" + touch), and the audio-session helpers.
 */
import { describe, expect, it } from "vitest";
import { hasNavigatorAudioSession, setNavigatorAudioSession } from "../../../../src/client/platform/audio-session";
import { detectIOS, detectSafari } from "../../../../src/client/platform/ios";
import { BrowserPageLifecycle, type AudioContextLike } from "../../../../src/client/platform/lifecycle";

class Target {
  private readonly ls = new Map<string, Set<() => void>>();
  addEventListener(k: string, cb: () => void) {
    if (!this.ls.has(k)) this.ls.set(k, new Set());
    this.ls.get(k)!.add(cb);
  }
  removeEventListener(k: string, cb: () => void) {
    this.ls.get(k)?.delete(cb);
  }
  fire(k: string) {
    for (const cb of [...(this.ls.get(k) ?? [])]) cb();
  }
  count() {
    return [...this.ls.values()].reduce((s, x) => s + x.size, 0);
  }
}
class Doc extends Target {
  visibilityState: "visible" | "hidden" = "visible";
}
class Ctx extends Target implements AudioContextLike {
  state = "running";
}

function setup(isIOS: boolean) {
  const doc = new Doc();
  const win = new Target();
  const ctx = new Ctx();
  const lc = new BrowserPageLifecycle({ doc: doc as never, win: win as never, isIOS });
  lc.attachContext(ctx);
  const ev: string[] = [];
  lc.onPause((r) => ev.push(`pause:${r}`));
  lc.onResume(() => ev.push("resume"));
  return { doc, win, ctx, lc, ev };
}

describe("BrowserPageLifecycle", () => {
  it("iOS: hidden → pause(ios_background) once; visible → resume once", () => {
    const { doc, lc, ev } = setup(true);
    doc.visibilityState = "hidden";
    doc.fire("visibilitychange");
    doc.fire("freeze");
    expect(ev).toEqual(["pause:ios_background"]);
    expect(lc.pausedReason).toBe("ios_background");
    doc.fire("resume");
    expect(ev).toEqual(["pause:ios_background"]); // still hidden
    doc.visibilityState = "visible";
    doc.fire("visibilitychange");
    expect(ev).toEqual(["pause:ios_background", "resume"]);
    expect(lc.pausedReason).toBeNull();
  });

  it("desktop: hidden tabs do NOT pause (audio keeps rendering)", () => {
    const { doc, win, ev } = setup(false);
    doc.visibilityState = "hidden";
    doc.fire("visibilitychange");
    win.fire("pagehide");
    expect(ev).toEqual([]);
  });

  it("any platform: ctx 'interrupted' → pause(audio_interrupted); resumes when the context runs again", () => {
    const { ctx, ev } = setup(false);
    ctx.state = "interrupted";
    ctx.fire("statechange");
    expect(ev).toEqual(["pause:audio_interrupted"]);
    ctx.state = "running";
    ctx.fire("statechange");
    expect(ev).toEqual(["pause:audio_interrupted", "resume"]);
  });

  it("iOS: pagehide pauses; a suspended context while hidden pauses", () => {
    const a = setup(true);
    a.win.fire("pagehide");
    expect(a.ev).toEqual(["pause:ios_background"]);
    const b = setup(true);
    b.doc.visibilityState = "hidden";
    b.ctx.state = "suspended";
    b.ctx.fire("statechange");
    expect(b.ev).toEqual(["pause:ios_background"]);
  });

  it("dispose removes every listener", () => {
    const { doc, win, ctx, lc } = setup(true);
    lc.dispose();
    expect(doc.count() + win.count() + ctx.count()).toBe(0);
  });
});

describe("platform helpers", () => {
  it("detectIOS / detectSafari", () => {
    expect(detectIOS({ userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1" })).toBe(true);
    expect(detectIOS({ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15", maxTouchPoints: 5 })).toBe(true);
    expect(detectIOS({ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15", maxTouchPoints: 0 })).toBe(false);
    expect(detectIOS({ userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/152.0 Safari/537.36" })).toBe(false);
    expect(detectSafari({ userAgent: "Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15" })).toBe(true);
    expect(detectSafari({ userAgent: "Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/152.0 Safari/537.36" })).toBe(false);
  });

  it("navigator.audioSession: sets the type when present", () => {
    const nav = { audioSession: { type: "auto" } };
    expect(setNavigatorAudioSession("playback", nav)).toBe(true);
    expect(nav.audioSession.type).toBe("playback");
    expect(hasNavigatorAudioSession(nav)).toBe(true);
    expect(setNavigatorAudioSession("playback", {})).toBe(false);
    expect(hasNavigatorAudioSession({})).toBe(false);
  });
});
