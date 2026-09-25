import { describe, expect, it } from "vitest";

import type { CreateCaseRequest, CreateCaseResponse, StartRunRequest } from "@/core/contracts/api";
import type { QaResult } from "@/core/contracts/events";
import type { RunPlan } from "@/core/contracts/run";
import type { CallManifestEntry } from "@/core/contracts/scenario";
import type { CallPlayback, CallTick, CaseSync, PageLifecycle } from "@/core/contracts/services";
import { emptyCaseState, S01_POLICY } from "@/client/fixtures/builder";
import type { SessionApi } from "@/client/session/api";
import { CallSession, type SessionControllers, type SttManagerLike, type TakeoverControllerLike } from "@/client/session/orchestrator";
import { createConsoleStore } from "@/client/store/store";

const CALL: CallManifestEntry = {
  callId: "s01-take2", scenarioId: "s01", title: "Add a driver", source: "twilio8k", language: "en", durationMs: 121_000,
  format: { encoding: "pcm_mulaw", sampleRate: 8000 }, publishAudio: true, inEval: true, featured: true, picker: "main",
  decisionPointMs: 106_500, handoff: { lineStartMs: 110_400, lineEndMs: 114_200, acceptStartMs: 114_800, acceptEndMs: 116_000, declined: false },
  recordedAiBundle: "s01-a", customerTailPack: null, assets: { rep: "/calls/s01/rep.x.ulaw", customer: "/calls/s01/customer.x.ulaw", peaks: "/calls/s01/peaks.x.json" },
};

function fakeApi(plan: Partial<RunPlan> = {}) {
  const log: string[] = [];
  let n = 0;
  const api: SessionApi = {
    status: async () => null,
    async createCase(req: CreateCaseRequest) {
      n++;
      log.push(`createCase prefill=${req.prefillUntilMs ?? 0}`);
      const res: CreateCaseResponse = {
        caseId: `case${n}`, caseToken: `tok${n}`, policy: S01_POLICY, call: CALL, state: emptyCaseState(`case${n}`),
        assets: CALL.assets as NonNullable<CallManifestEntry["assets"]>, cachedTurnsUrl: "/data/cached-turns/s01-take2.json",
      };
      return res;
    },
    async startRun(req: StartRunRequest, token: string) {
      log.push(`startRun ${req.caseId} express=${req.express} ${token}`);
      return { runId: `run-${req.caseId}`, caseId: req.caseId, sttHalf: "live", aiHalf: "live", vaHoldId: "h", holdExpiresAt: null, reason: null, recordedHandoffMs: null, ...plan };
    },
    async releaseRun(runId, token, keepalive) {
      log.push(`release ${runId} ${token} keepalive=${!!keepalive}`);
    },
    async verification() {
      log.push("verification");
      return { status: "completed", qa: QA, elapsedMs: 18_000 };
    },
    peaks: async () => ({ ratePerSec: 50, rep: [0.1], customer: [0.2] }),
  };
  return { api, log };
}

const QA: QaResult = {
  provisional: false, reAsked: 0, newlyAsked: 0, pendingConfirmed: 1, verifiedReconfirmed: 0, disclosures: [], clickToFirstAudibleMs: 4100,
  deadAirAfterRepMs: 420, turnLatencyP50Ms: 2300, payment: "simulated", handedBack: false, aiSeconds: 90, adviceFlags: 0, details: [],
};

function fakeControllers(o: { sttResult?: "live" | "queued" | "denied" } = {}) {
  const log: string[] = [];
  let tickCb: ((t: CallTick) => void) | null = null;
  let endedCb: (() => void) | null = null;
  let takeoverEnded: ((e: { takeoverId: string; takeoverToken: string; outcome: string }) => void) | null = null;
  const playback = {
    start: (from: number) => void log.push(`play.start ${from}`),
    stop: () => void log.push("play.stop"),
    dispose: () => void log.push("play.dispose"),
    callMs: 0,
    onTick: (cb: (t: CallTick) => void) => ((tickCb = cb), () => {}),
    onEnded: (cb: () => void) => ((endedCb = cb), () => {}),
    duck: (v: number) => void log.push(`duck ${v}`),
    channelEnergyDb: () => -60,
    playSpan: async (ch: string, a: number, b: number) => void log.push(`span ${ch} ${a} ${b}`),
    playHandoffClip: async () => ({ endCtxMs: 0 }),
  } as unknown as CallPlayback;
  const stt = {
    open: async (p: { startOffsetMs: number }) => (log.push(`stt.open ${p.startOffsetMs}`), o.sttResult ?? "live"),
    feed: () => void log.push("stt.feed"),
    hasOpenPartial: () => false,
    forceEndpoint: () => {},
    pause: async () => void log.push("stt.pause"),
    resume: async () => void log.push("stt.resume"),
    terminateAll: async () => (log.push("stt.terminateAll"), []),
    status: { rep: "open", customer: "open" },
    finishAfterSilence: async () => void log.push("stt.finish"),
    dispose: () => void log.push("stt.dispose"),
  } as unknown as SttManagerLike;
  const takeover: TakeoverControllerLike = {
    arm: async (src) => void log.push(`arm ${src}`),
    phase: "idle",
    abort: () => {},
    manualPassAllowed: true,
    onEnded: (cb) => ((takeoverEnded = cb), () => {}),
  };
  const lifecycle: PageLifecycle & { attachContext(): void } = {
    onPause: () => () => {},
    onResume: () => () => {},
    isIOS: false,
    attachContext: () => void log.push("lifecycle.attach"),
  };
  const controllers: SessionControllers = {
    engine: () =>
      ({
        ctx: {} as AudioContext,
        unlockSync: () => void log.push("unlockSync"),
        nowMs: () => 0,
        setAudioSession: () => {},
        loadCall: async () => (log.push("loadCall"), playback),
        createVaOutput: () => { throw new Error("unused"); },
        createFeeder: () => { throw new Error("unused"); },
        openMic: () => { throw new Error("unused"); },
        playPcm24k: async () => {},
      }) as never,
    lifecycle: () => lifecycle,
    createCaseSync: () => ({ enqueue: () => {}, drain: async () => ({ completedTurnIds: [], pendingTurnIds: [], waitedMs: 0 }), state: null, onState: () => () => {} }) as CaseSync,
    createCachedReplay: () => ({ ensureLoaded: async () => {}, activate: (ch, from, reason) => void log.push(`cached.activate ${ch} ${from} ${reason}`) }),
    createStt: () => stt,
    createTakeover: (c) => (log.push(`createTakeover plan=${c.plan.runId}`), takeover),
  };
  return { controllers, log, tick: (t: CallTick) => tickCb?.(t), end: () => endedCb?.(), takeoverEnded: (e: { takeoverId: string; takeoverToken: string; outcome: string }) => takeoverEnded?.(e), takeover };
}

const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
};

describe("CallSession orchestrator", () => {
  it("prepare: /api/cases (Express prefill) → /api/runs → context + run plan on the store", async () => {
    const store = createConsoleStore();
    const { api, log } = fakeApi();
    const s = new CallSession({ callId: "s01-take2", call: CALL, api, store, controllers: null, now: () => 1 });
    await s.prepare();
    expect(log).toEqual(["createCase prefill=81500", "startRun case1 express=true tok1"]);
    const st = store.getState();
    expect(st.phase).toBe("preflight");
    expect(st.context?.durationMs).toBe(121_000);
    expect(st.context?.peaks?.rep).toEqual([0.1]);
    expect(st.plan?.runId).toBe("run-case1");
  });

  it("start: unlockSync runs synchronously in the click, before any await; then load → STT open → play", async () => {
    const store = createConsoleStore();
    const { api } = fakeApi();
    const f = fakeControllers();
    const s = new CallSession({ callId: "s01-take2", call: CALL, api, store, controllers: f.controllers, now: () => 5 });
    await s.prepare();
    s.start("express");
    expect(f.log).toEqual(["unlockSync", "lifecycle.attach"]); // nothing async has run yet
    await flush();
    expect(f.log).toEqual(["unlockSync", "lifecycle.attach", "loadCall", "stt.open 81500", "createTakeover plan=run-case1", "play.start 81500"]);
    expect(store.getState().started).toMatchObject({ kind: "express", startOffsetMs: 81_500 });
    f.tick({ callMs: 81_600, playing: true, rep: new Uint8Array(), customer: new Uint8Array() });
    expect(f.log).toContain("stt.feed");
    expect(store.getState().clock.callMs).toBe(81_600);
  });

  it("the full call re-creates the case without the prefill and releases the Express run first", async () => {
    const store = createConsoleStore();
    const { api, log } = fakeApi();
    const f = fakeControllers();
    const s = new CallSession({ callId: "s01-take2", call: CALL, api, store, controllers: f.controllers, now: () => 5 });
    await s.prepare();
    s.start("full");
    await flush();
    expect(log).toEqual([
      "createCase prefill=81500", "startRun case1 express=true tok1", "release run-case1 tok1 keepalive=false", "createCase prefill=0", "startRun case2 express=false tok2",
    ]);
    expect(f.log).toContain("play.start 0");
  });

  it("a cached plan or a denied STT open goes to the labelled cached replay", async () => {
    for (const [plan, stt] of [[{ sttHalf: "cached" as const, reason: "budget" }, "live"], [{}, "denied"]] as const) {
      const store = createConsoleStore();
      const { api } = fakeApi(plan);
      const f = fakeControllers({ sttResult: stt });
      const s = new CallSession({ callId: "s01-take2", call: CALL, api, store, controllers: f.controllers, now: () => 5 });
      await s.prepare();
      s.start("express");
      await flush();
      expect(f.log.some((l) => l.startsWith("cached.activate both 81500"))).toBe(true);
    }
  });

  it("pass arms a manual takeover only when allowed; evidence ducks and plays the padded span", async () => {
    const store = createConsoleStore();
    const { api } = fakeApi();
    const f = fakeControllers();
    const s = new CallSession({ callId: "s01-take2", call: CALL, api, store, controllers: f.controllers, now: () => 5 });
    await s.prepare();
    s.start("express");
    await flush();
    s.pass();
    await flush();
    expect(f.log).toContain("arm manual");
    await s.playEvidence({ channel: "rep", turnId: "rep-4", startMs: 90_000, endMs: 90_500, quote: "Friday", source: "stt_live" });
    expect(f.log.slice(-3)).toEqual(["duck 0.2", "span rep 89500 91000", "duck 1"]);
    (f.takeover as { manualPassAllowed: boolean }).manualPassAllowed = false;
    const before = f.log.length;
    s.pass();
    await flush();
    expect(f.log.length).toBe(before);
  });

  it("takeover end → verification poll → verified QA on the store", async () => {
    const store = createConsoleStore();
    const { api, log } = fakeApi();
    const f = fakeControllers();
    const s = new CallSession({ callId: "s01-take2", call: CALL, api, store, controllers: f.controllers, now: () => 5, verifyPollMs: 1 });
    await s.prepare();
    s.start("express");
    await flush();
    f.takeoverEnded({ takeoverId: "tk1", takeoverToken: "tt", outcome: "completed" });
    await flush();
    expect(log).toContain("verification");
    expect(store.getState().qa.status).toBe("verified");
    expect(store.getState().qa.verified?.pendingConfirmed).toBe(1);
  });

  it("recording end without a pass → call-ended + hold release; pagehide releases with keepalive once", async () => {
    const store = createConsoleStore();
    const { api, log } = fakeApi();
    const f = fakeControllers();
    const s = new CallSession({ callId: "s01-take2", call: CALL, api, store, controllers: f.controllers, now: () => 5 });
    await s.prepare();
    s.start("express");
    await flush();
    f.end();
    await flush();
    expect(store.getState().callEnded).toBe(true);
    expect(log.filter((l) => l.startsWith("release"))).toEqual(["release run-case1 tok1 keepalive=false"]);
    s.dispose();
    expect(log.filter((l) => l.startsWith("release"))).toHaveLength(1);
    expect(f.log).toContain("stt.dispose");

    const store2 = createConsoleStore();
    const a2 = fakeApi();
    const s2 = new CallSession({ callId: "s01-take2", call: CALL, api: a2.api, store: store2, controllers: null, now: () => 5 });
    await s2.prepare();
    s2.dispose();
    expect(a2.log.at(-1)).toBe("release run-case1 tok1 keepalive=true");
  });

  it("without wired controllers, Start explains instead of failing silently", async () => {
    const store = createConsoleStore();
    const { api } = fakeApi();
    const s = new CallSession({ callId: "s01-take2", call: CALL, api, store, controllers: null, now: () => 5 });
    await s.prepare();
    s.start("express");
    expect(store.getState().phase).toBe("error");
    expect(store.getState().error?.message).toMatch(/not wired/);
  });
});
