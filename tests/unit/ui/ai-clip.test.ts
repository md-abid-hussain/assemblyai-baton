/**
 * WP7·2: AI-half evidence clips through WP8's route #21 (Bearer takeover token → 302 → OGG), fetched once per VA
 * session as a blob and played per clip window; 404 + Retry-After while the recording is written.
 */
import { describe, expect, it } from "vitest";

import { createAiClipPlayer, type ClipAudio } from "@/client/session/ai-clip";
import type { Evidence } from "@/core/contracts/case";

const EV: Evidence = { channel: "ai", turnId: "r3", startMs: 12_000, endMs: 13_500, quote: "October 2nd", source: "va_transcript" };

function harness(responses: Array<{ status: number; retryAfter?: string }>) {
  const calls: { url: string; auth: string | null }[] = [];
  const audios: (ClipAudio & { src: string; played: number; paused: number })[] = [];
  const timers: (() => void)[] = [];
  const logs: string[] = [];
  const player = createAiClipPlayer({
    fetchImpl: (async (url: string, init?: RequestInit) => {
      calls.push({ url, auth: new Headers(init?.headers).get("authorization") });
      const r = responses.shift() ?? { status: 200 };
      const headers = new Headers(r.retryAfter ? { "retry-after": r.retryAfter } : {});
      return r.status === 200 ? new Response(new Blob(["ogg"]), { status: 200, headers }) : new Response(null, { status: r.status, headers });
    }) as typeof fetch,
    createObjectUrl: () => "blob:ogg-1",
    createAudio: (src) => {
      const a = { src, currentTime: 0, played: 0, paused: 0, onended: null as (() => void) | null, play: async () => void a.played++, pause: () => void a.paused++ };
      audios.push(a);
      return a;
    },
    sleep: async () => {},
    setTimeout: (cb) => timers.push(cb),
    clearTimeout: () => {},
    log: (_l, msg) => logs.push(msg),
  });
  return { player, calls, audios, timers, logs };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("AI-half evidence clips (route #21)", () => {
  it("fetches the recording once with the takeover token and plays each window from the blob", async () => {
    const h = harness([{ status: 404, retryAfter: "3" }, { status: 200 }]);
    const auth = { takeoverToken: "tt_1", vaSessionId: "va_9" };
    const p1 = h.player(EV, { fromMs: 11_500, toMs: 14_000 }, auth);
    await flush();
    await flush();
    expect(h.calls).toEqual([
      { url: "/api/va-sessions/va_9/audio", auth: "Bearer tt_1" },
      { url: "/api/va-sessions/va_9/audio", auth: "Bearer tt_1" },
    ]);
    expect(h.audios[0]).toMatchObject({ src: "blob:ogg-1", currentTime: 11.5, played: 1 });
    h.timers.shift()!(); // the window ends
    await p1;
    expect(h.audios[0]!.paused).toBe(1);

    const p2 = h.player(EV, { fromMs: 20_000, toMs: 21_000 }, auth);
    await flush();
    expect(h.calls).toHaveLength(2); // cached per VA session
    expect(h.audios[1]).toMatchObject({ currentTime: 20, played: 1 });
    h.audios[1]!.onended?.();
    await p2;
  });

  it("stays silent without a VA session or token, and on a refused recording (retried on the next click)", async () => {
    const h = harness([{ status: 403 }, { status: 200 }]);
    await h.player(EV, { fromMs: 0, toMs: 1000 }, { takeoverToken: null, vaSessionId: "va_9" });
    expect(h.calls).toHaveLength(0);
    await h.player(EV, { fromMs: 0, toMs: 1000 }, { takeoverToken: "tt_1", vaSessionId: "va_9" });
    expect(h.audios).toHaveLength(0);
    expect(h.logs).toEqual(["AI evidence clip unavailable"]);
    const p = h.player(EV, { fromMs: 0, toMs: 1000 }, { takeoverToken: "tt_1", vaSessionId: "va_9" });
    await flush();
    expect(h.calls).toHaveLength(2);
    h.audios[0]!.onended?.();
    await p;
  });
});
