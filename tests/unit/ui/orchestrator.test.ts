import { describe, expect, it } from "vitest";

import type { CreateCaseRequest, CreateCaseResponse, StartRunRequest } from "@/core/contracts/api";
import { BatonError } from "@/core/contracts/errors";
import type { BatonEvent, QaResult } from "@/core/contracts/events";
import type { TakeoverClientView, TakeoverControllerExt } from "@/core/contracts/ext/wp5-takeover";
import type { RunPlan } from "@/core/contracts/run";
import type { CallManifestEntry } from "@/core/contracts/scenario";
import type { CallPlayback, CallTick, CaseSync } from "@/core/contracts/services";
import type { CompiledListening, UiSpec } from "@/core/contracts/v2/relay";
import type { TurnInput } from "@/core/contracts/turns";
import { fixtureLog } from "@/client/fixtures";
import { emptyCaseState, S01_POLICY } from "@/client/fixtures/builder";
import type { SessionApi } from "@/client/session/api";
import { CallSession, type LifecycleLike, type SessionContext, type SessionControllers, type SttManagerLike } from "@/client/session/orchestrator";
import { qaVerifiedCopy, softNotice } from "@/client/store/selectors";
import { BATON_UI_SPEC } from "@/client/store/ui-spec";
import { createConsoleStore } from "@/client/store/store";

const CALL: CallManifestEntry = {
  callId: "s01-take2", scenarioId: "s01", title: "Add a driver", source: "twilio8k", language: "en", durationMs: 121_000,
  format: { encoding: "pcm_mulaw", sampleRate: 8000 }, publishAudio: true, inEval: true, featured: true, picker: "main",
  decisionPointMs: 106_500, handoff: { lineStartMs: 110_400, lineEndMs: 114_200, acceptStartMs: 114_800, acceptEndMs: 116_000, declined: false },
  recordedAiBundle: "s01-a", customerTailPack: null, assets: { rep: "/calls/s01/rep.x.ulaw", customer: "/calls/s01/customer.x.ulaw", peaks: "/calls/s01/peaks.x.json" },
};

/** Cached finals: the rep turn arriving at 79.9 s is the newest clean cut before the 81.5 s target (WP4 expressStart). */
const CACHED = {
  callId: "s01-take2", variant: "pc_ctx", transcribedAt: "2026-09-20T10:00:00Z",
  channels: {
    rep: [
      { recvMs: 79_900, message: { type: "Turn", end_of_turn: true, transcript: "So the effective date is Friday.", words: [{ start: 77_000, end: 79_400 }] } },
      { recvMs: 90_000, message: { type: "Turn", end_of_turn: true, transcript: "Great.", words: [{ start: 88_000, end: 89_000 }] } },
    ],
    customer: [{ recvMs: 60_000, message: { type: "Turn", end_of_turn: true, transcript: "Yes.", words: [{ start: 59_000, end: 59_500 }] } }],
  },
};

const QA: QaResult = {
  provisional: false, reAsked: 0, newlyAsked: 0, pendingConfirmed: 1, verifiedReconfirmed: 0, disclosures: [], clickToFirstAudibleMs: 4100,
  deadAirAfterRepMs: 420, turnLatencyP50Ms: 2300, payment: "simulated", handedBack: false, aiSeconds: 90, adviceFlags: 0, details: [],
};

/** The v2 fields a relay-aware server sends with the case (`CreateCaseResponseV2`); a v1 server sends none. */
const V2_LISTENING: CompiledListening = {
  keyterms: ["Cedar Hollow Dental", "periodontal scaling"],
  prompt: "A dental receptionist takes a booking deposit.",
  languageCodes: ["en"],
  tuning: "telephony_8k",
};

function fakeApi(plan: Partial<RunPlan> = {}, o: { cached?: boolean; verification?: "completed" | "404"; relay?: UiSpec } = {}) {
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
        ...(n === 1 ? { visitorToken: "vt1" } : {}),
      };
      // A relay-aware server also states the run's relay and its compiled listening (a v1 server sends neither).
      return o.relay ? { ...res, relay: o.relay, listening: V2_LISTENING } : res;
    },
    async startRun(req: StartRunRequest, token: string) {
      log.push(`startRun ${req.caseId} express=${req.express} ${token}`);
      return { runId: `run-${req.caseId}`, caseId: req.caseId, sttHalf: "live", aiHalf: "live", vaHoldId: "h", holdExpiresAt: null, reason: null, recordedHandoffMs: null, ...plan };
    },
    async releaseRun(runId, token, keepalive) {
      log.push(`release ${runId} ${token} keepalive=${!!keepalive}`);
    },
    async verification(id, token) {
      log.push(`verification ${id} ${token}`);
      if (o.verification === "404") throw new BatonError("E_NOT_FOUND", "no verification");
      return { status: "completed", qa: QA, elapsedMs: 18_000 };
    },
    async getJson(url: string) {
      log.push(`get ${url}`);
      if (url.includes("cached-turns")) return o.cached ? CACHED : null;
      if (url.includes("peaks")) return { ratePerSec: 50, rep: [0.1], customer: [0.2] };
      return null;
    },
  };
  return { api, log };
}

class FakeTakeover implements TakeoverControllerExt {
  readonly phase = "idle" as const;
  manualPassAllowed = true;
  armed = false;
  finals: string[] = [];
  cbs = new Set<() => void>();
  v: TakeoverClientView = { phase: "idle", manualPassAllowed: true, passes: 0, lastOutcome: null, pass: null, notice: null, verificationJobId: null };
  constructor(private readonly log: string[]) {}
  async arm(src: "manual" | "auto_handoff") {
    this.log.push(`arm ${src}`);
    this.armed = true;
  }
  abort() {}
  endCall(reason: string) {
    this.log.push(`endCall ${reason}`);
  }
  noteFinal(t: { turnId: string }) {
    this.finals.push(t.turnId);
  }
  armInfo() {
    return { armed: this.armed, tArmMs: this.armed ? 100_000 : null };
  }
  view() {
    return this.v;
  }
  subscribe(cb: () => void) {
    this.cbs.add(cb);
    return () => void this.cbs.delete(cb);
  }
  dispose() {
    this.log.push("takeover.dispose");
  }
  /** A view change without the end of a pass (e.g. a notice). */
  set(v: Partial<TakeoverClientView>) {
    this.v = { ...this.v, ...v };
    for (const cb of [...this.cbs]) cb();
  }
  /** WP5: /end answered → the verification job id appears on the view. */
  ended(takeoverId: string) {
    this.v = { ...this.v, phase: "done", pass: { takeoverId } as TakeoverClientView["pass"], verificationJobId: "job_1" };
    for (const cb of [...this.cbs]) cb();
  }
}

function fakeControllers(o: { sttResult?: "live" | "queued" | "denied"; whenRunning?: boolean } = {}) {
  const log: string[] = [];
  let tickCb: ((t: CallTick) => void) | null = null;
  let endedCb: (() => void) | null = null;
  let sink: SessionContext["sink"] | null = null;
  const sttStatus: SttManagerLike["status"] = { rep: "idle", customer: "idle" };
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
  const sttOpens: { startOffsetMs: number; listening?: unknown }[] = [];
  const stt = {
    open: async (p: { startOffsetMs: number; seedAgentContext?: string; listening?: unknown }) => {
      sttOpens.push({ startOffsetMs: p.startOffsetMs, listening: p.listening });
      log.push(`stt.open ${p.startOffsetMs}${p.seedAgentContext ? ` seed="${p.seedAgentContext}"` : ""}`);
      const r = o.sttResult ?? "live";
      const st = r === "live" ? "open" : r === "denied" ? "cached" : "queued";
      sttStatus.rep = st;
      sttStatus.customer = st;
      return r;
    },
    feed: () => void log.push("stt.feed"),
    hasOpenPartial: () => false,
    forceEndpoint: () => {},
    pause: async () => void log.push("stt.pause"),
    resume: async () => void log.push("stt.resume"),
    terminateAll: async () => (log.push("stt.terminateAll"), []),
    status: sttStatus,
    providerSessionIds: { rep: "s-rep", customer: "s-cus" },
    finishAfterSilence: async () => void log.push("stt.finish"),
    dispose: () => void log.push("stt.dispose"),
  } as unknown as SttManagerLike;
  const takeover = new FakeTakeover(log);
  const lifecycle: LifecycleLike = {
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
        whenRunning: async () => o.whenRunning ?? true,
        nowMs: () => 0,
        setAudioSession: () => {},
        loadCall: async () => (log.push("loadCall"), playback),
        createVaOutput: () => {
          throw new Error("unused");
        },
        createFeeder: () => {
          throw new Error("unused");
        },
        openMic: () => {
          throw new Error("unused");
        },
        playPcm24k: async () => {},
      }) as never,
    lifecycle: () => lifecycle,
    createHumanHalf: (c) => {
      sink = c.sink;
      log.push(`human ${c.create.caseId} start=${c.startOffsetMs}`);
      return {
        caseSync: { enqueue: () => {}, drain: async () => ({ completedTurnIds: [], pendingTurnIds: [], waitedMs: 0 }), state: null, onState: () => () => {} } as CaseSync,
        cached: { ensureLoaded: async () => {}, activate: (ch, from, reason) => void log.push(`cached.activate ${ch} ${from} ${reason}`) },
        stt,
      };
    },
    createTakeover: (c) => {
      log.push(`createTakeover ${c.plan.runId} mode=${c.mode}`);
      return { ctl: takeover, token: () => "tt_1", askForRep: () => void log.push("askForRep"), setSessionIds: (ids) => void log.push(`hud.ids ${ids.rep}/${ids.customer}`) };
    },
  };
  return {
    controllers, log, takeover, sttStatus, sttOpens,
    tick: (t: CallTick) => tickCb?.(t),
    end: () => endedCb?.(),
    emit: (ev: BatonEvent) => sink?.emit(ev),
  };
}

const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
};

const turn = (turnId: string, channel: "rep" | "customer", startMs: number, endMs: number): TurnInput => ({
  caseId: "case1", turnId, channel, text: "hello there", startMs, endMs, words: [], source: "stt_live", recvMs: endMs + 400, cut: false, late: false,
});

describe("CallSession orchestrator (real-controller seams)", () => {
  it("prepare: Express by default → WP4 expressStart cut from cached turns + peaks → /api/cases {prefill = cut} → /api/runs", async () => {
    const store = createConsoleStore();
    const { api, log } = fakeApi({}, { cached: true });
    const s = new CallSession({ callId: "s01-take2", call: CALL, api, store, controllers: null, now: () => 1 });
    await s.prepare();
    expect(log).toEqual([
      "get /data/cached-turns/s01-take2.json", "get /calls/s01/peaks.x.json", "createCase prefill=79900", "startRun case1 express=true tok1",
    ]);
    expect(s.debug.express).toMatchObject({ startOffsetMs: 79_900, snappedTo: "turn_boundary", seedAgentContext: "So the effective date is Friday." });
    expect(s.visitorToken).toBe("vt1");
    const st = store.getState();
    expect(st.phase).toBe("preflight");
    expect(st.context?.peaks?.rep).toEqual([0.1]);
    expect(st.plan?.runId).toBe("run-case1");
  });

  it("without cached turns the cut is the unsnapped target (decision point − 25 s)", async () => {
    const { api, log } = fakeApi();
    const s = new CallSession({ callId: "s01-take2", call: CALL, api, store: createConsoleStore(), controllers: null, now: () => 1 });
    await s.prepare();
    expect(log).toContain("createCase prefill=81500");
  });

  it("start: unlockSync in the click; then human half → takeover → STT open with the seed → play from the cut", async () => {
    const store = createConsoleStore();
    const { api } = fakeApi({}, { cached: true });
    const f = fakeControllers();
    const s = new CallSession({ callId: "s01-take2", call: CALL, api, store, controllers: f.controllers, now: () => 5 });
    await s.prepare();
    s.start("express");
    expect(f.log).toEqual(["unlockSync", "lifecycle.attach"]); // nothing async has run yet
    await flush();
    expect(f.log).toEqual([
      "unlockSync", "lifecycle.attach", "loadCall", "human case1 start=79900", "createTakeover run-case1 mode=watch",
      `stt.open 79900 seed="So the effective date is Friday."`, "hud.ids s-rep/s-cus", "play.start 79900",
    ]);
    expect(store.getState().started).toMatchObject({ kind: "express", startOffsetMs: 79_900 });
    expect(store.getState().sessionIds).toEqual({ rep: "s-rep", customer: "s-cus" });
    f.tick({ callMs: 80_000, playing: true, rep: new Uint8Array(), customer: new Uint8Array() });
    expect(f.log).toContain("stt.feed");
    expect(store.getState().clock.callMs).toBe(80_000);
    // a second click does nothing
    s.start("express");
    expect(f.log.filter((l) => l === "unlockSync")).toHaveLength(1);
  });

  it("a generated take is never labelled a recording: call-provenance.json overrides the server's human half (G2b §6.1)", async () => {
    const store = createConsoleStore();
    const { api } = fakeApi({}, { cached: true, relay: BATON_UI_SPEC });
    const f = fakeControllers();
    const detail = "Simulated audio: script by gpt-6-luna, voices by gpt-4o-mini-tts. Fictional people.";
    const s = new CallSession({
      callId: "s01-take2", call: CALL, api, store, controllers: f.controllers, now: () => 5,
      callProvenance: { humanHalf: "simulated", detail },
    });
    await s.prepare();
    const p = store.getState().provenance;
    expect(p?.humanHalf).toBe("simulated");
    expect(p?.detail).toBe(detail);
    // A simulated human half has no recorded customer to answer the AI.
    expect(p?.customerInAiHalf).toBe("synthetic");
    // And the QA card must not claim a recording it does not have.
    expect(qaVerifiedCopy(store.getState()).badge).toContain("customer audio simulated");
  });

  it("a real recorded take keeps the server's strip untouched", async () => {
    const store = createConsoleStore();
    const { api } = fakeApi({}, { cached: true, relay: BATON_UI_SPEC });
    const f = fakeControllers();
    const s = new CallSession({
      callId: "s01-take2", call: CALL, api, store, controllers: f.controllers, now: () => 5,
      callProvenance: { humanHalf: "recorded", detail: "" },
    });
    await s.prepare();
    expect(store.getState().provenance?.humanHalf).toBe("recorded");
    expect(qaVerifiedCopy(store.getState()).badge).toBe("Verified from recording");
  });

  it("a non-flagship relay is transcribed with its own listening; the flagship (and a v1 server) is not", async () => {
    // WP7·3 / PLATFORM §7.6: the server states `listening` per relay, and only a relay other than Baton overrides
    // route #5's params with it — the flagship's human half must stay exactly what it was before relays existed.
    const dental: UiSpec = { ...BATON_UI_SPEC, relay: { ...BATON_UI_SPEC.relay, slug: "dental-deposit", title: "Dental · booking deposit", flagship: false } };
    const run = async (relay?: UiSpec) => {
      const f = fakeControllers();
      const { api } = fakeApi({}, { cached: true, ...(relay ? { relay } : {}) });
      const s = new CallSession({ callId: "s01-take2", call: CALL, api, store: createConsoleStore(), controllers: f.controllers, now: () => 5 });
      await s.prepare();
      s.start("express");
      await flush();
      return f.sttOpens;
    };
    expect((await run(dental))[0]?.listening).toMatchObject({ prompt: "A dental receptionist takes a booking deposit." });
    expect((await run(BATON_UI_SPEC))[0]?.listening).toBeUndefined();
    expect((await run())[0]?.listening).toBeUndefined(); // a v1 server sends no v2 fields at all
  });

  it("every stt.final reaches the store AND TakeoverController.noteFinal (the cut-turn marker)", async () => {
    const store = createConsoleStore();
    const { api } = fakeApi();
    const f = fakeControllers();
    const s = new CallSession({ callId: "s01-take2", call: CALL, api, store, controllers: f.controllers, now: () => 5 });
    await s.prepare();
    s.start("express");
    await flush();
    f.emit({ t: 6, type: "stt.final", turn: turn("rep-3", "rep", 82_000, 84_000) });
    expect(f.takeover.finals).toEqual(["rep-3"]);
    expect(store.getState().human.map((l) => l.turnId)).toContain("rep-3");
  });

  it("the full call re-creates the case without the prefill and releases the Express run first", async () => {
    const store = createConsoleStore();
    const { api, log } = fakeApi();
    const f = fakeControllers();
    const s = new CallSession({ callId: "s01-take2", call: CALL, api, store, controllers: f.controllers, now: () => 5 });
    await s.prepare();
    s.start("full");
    await flush();
    expect(log.filter((l) => !l.startsWith("get "))).toEqual([
      "createCase prefill=81500", "startRun case1 express=true tok1", "release run-case1 tok1 keepalive=false", "createCase prefill=0", "startRun case2 express=false tok2",
    ]);
    expect(f.log).toContain("play.start 0");
    expect(store.getState().started).toMatchObject({ kind: "full", startOffsetMs: 0 });
  });

  it("a cached plan goes to the labelled cached replay; a denied open leaves it to WP4 (no double activation)", async () => {
    const a = fakeApi({ sttHalf: "cached", reason: "budget" });
    const f = fakeControllers();
    const s = new CallSession({ callId: "s01-take2", call: CALL, api: a.api, store: createConsoleStore(), controllers: f.controllers, now: () => 5 });
    await s.prepare();
    s.start("express");
    await flush();
    expect(f.log).toContain("cached.activate both 81500 budget");
    expect(f.log.some((l) => l.startsWith("stt.open"))).toBe(false);

    const b = fakeApi();
    const g = fakeControllers({ sttResult: "denied" });
    const s2 = new CallSession({ callId: "s01-take2", call: CALL, api: b.api, store: createConsoleStore(), controllers: g.controllers, now: () => 5 });
    await s2.prepare();
    s2.start("express");
    await flush();
    expect(g.log.some((l) => l.startsWith("cached.activate"))).toBe(false);
    expect(g.log).toContain("play.start 81500");
  });

  it("queued: playback waits until both channels are live, or the judge picks the cached replay", async () => {
    const store = createConsoleStore();
    const { api } = fakeApi();
    const f = fakeControllers({ sttResult: "queued" });
    const s = new CallSession({ callId: "s01-take2", call: CALL, api, store, controllers: f.controllers, now: () => 5 });
    await s.prepare();
    s.start("express");
    await flush();
    expect(f.log.some((l) => l.startsWith("play.start"))).toBe(false);
    f.sttStatus.rep = "open";
    f.sttStatus.customer = "open";
    f.emit({ t: 7, type: "stt.status", channel: "customer", status: "open" });
    await flush();
    expect(f.log).toContain("play.start 81500");

    const g = fakeControllers({ sttResult: "queued" });
    const s2 = new CallSession({ callId: "s01-take2", call: CALL, api: fakeApi().api, store: createConsoleStore(), controllers: g.controllers, now: () => 5 });
    await s2.prepare();
    s2.start("express");
    await flush();
    s2.watchCachedNow();
    await flush();
    expect(g.log).toEqual(expect.arrayContaining(["stt.terminateAll", "play.start 81500"]));
    expect(g.log.some((l) => l.startsWith("cached.activate both 81500"))).toBe(true);
  });

  it("an AudioContext that is not running after 300 ms shows 'Tap to enable sound'", async () => {
    const store = createConsoleStore();
    const f = fakeControllers({ whenRunning: false });
    const s = new CallSession({ callId: "s01-take2", call: CALL, api: fakeApi().api, store, controllers: f.controllers, now: () => 5 });
    await s.prepare();
    s.start("express");
    await flush();
    expect(store.getState().audioLocked).toBe(true);
    s.unlockAudio();
    expect(store.getState().audioLocked).toBe(false);
  });

  it("pass re-unlocks audio and arms WP5 only when allowed; Ask for rep / End call reach the takeover", async () => {
    const store = createConsoleStore();
    const { api } = fakeApi();
    const f = fakeControllers();
    const s = new CallSession({ callId: "s01-take2", call: CALL, api, store, controllers: f.controllers, now: () => 5 });
    await s.prepare();
    s.start("express");
    await flush();
    s.pass();
    await flush();
    expect(f.log.slice(-2)).toEqual(["unlockSync", "arm manual"]);
    f.takeover.manualPassAllowed = false;
    const before = f.log.length;
    s.pass();
    expect(f.log.length).toBe(before);
    s.askForDaniel();
    s.endCall();
    expect(f.log.slice(-2)).toEqual(["askForRep", "endCall user_end"]);
    await s.playEvidence({ channel: "rep", turnId: "rep-4", startMs: 90_000, endMs: 90_500, quote: "Friday", source: "stt_live" });
    expect(f.log.slice(-3)).toEqual(["duck 0.2", "span rep 89500 91000", "duck 1"]);
  });

  it("WP5 /end → verificationJobId on the view → poll #20 with the takeover token → verified QA", async () => {
    const store = createConsoleStore();
    const { api, log } = fakeApi();
    const f = fakeControllers();
    const s = new CallSession({ callId: "s01-take2", call: CALL, api, store, controllers: f.controllers, now: () => 5, verifyPollMs: 1 });
    await s.prepare();
    s.start("express");
    await flush();
    f.takeover.ended("tko_1");
    f.takeover.ended("tko_1"); // a second view change never starts a second poll
    await flush();
    expect(log.filter((l) => l.startsWith("verification"))).toEqual(["verification tko_1 tt_1"]);
    expect(store.getState().qa.status).toBe("verified");
    expect(store.getState().qa.verified?.pendingConfirmed).toBe(1);
  });

  it("the pass ends → provisional QA from the page's own captions at once (WP1 computeQa); a 404 from #20 keeps it", async () => {
    const store = createConsoleStore();
    const { api } = fakeApi({}, { verification: "404" });
    const f = fakeControllers();
    const s = new CallSession({ callId: "s01-take2", call: CALL, api, store, controllers: f.controllers, now: () => 5, verifyPollMs: 1 });
    await s.prepare();
    s.start("express");
    await flush();
    // the AI half as the page saw it (s01-full up to the takeover's `done`, without the fixture's own QA events)
    for (const e of fixtureLog("s01-full") ?? []) {
      if (e.type === "qa") continue;
      store.apply(e);
      if (e.type === "takeover.phase" && e.phase === "done") break;
    }
    expect(store.getState().qa.provisional).toBeNull();
    f.takeover.ended("tko_1");
    await flush();
    const qa = store.getState().qa;
    expect(qa.provisional).toMatchObject({ provisional: true, reAsked: 0, payment: "verified_webhook" });
    expect(qa.provisional!.disclosures.map((d) => d.kind)).toEqual(["premium_change", "esign_consent"]);
    expect(qa).toMatchObject({ status: "failed", reason: "there is no recording to verify", verified: null });
  });

  it("WP5 info notices become the top bar's soft line; error notices stay errors", async () => {
    const store = createConsoleStore();
    const { api } = fakeApi();
    const f = fakeControllers();
    const s = new CallSession({ callId: "s01-take2", call: CALL, api, store, controllers: f.controllers, now: () => 5 });
    await s.prepare();
    s.start("express");
    await flush();
    const msg = "Live AI is unavailable, so the recorded AI session plays (labelled).";
    f.takeover.set({ notice: { level: "info", code: null, message: msg } });
    expect(store.getState().notice).toBe(msg);
    expect(softNotice(store.getState())).toBe(msg);
    f.takeover.set({ notice: { level: "error", code: "E_VA_CONFIG", message: "The live AI could not start: x" } });
    expect(store.getState().notice).toBe(msg);
  });

  it("a 404 from #20 (no VA recording) keeps the provisional numbers with a plain reason", async () => {
    const store = createConsoleStore();
    const { api } = fakeApi({}, { verification: "404" });
    const f = fakeControllers();
    const s = new CallSession({ callId: "s01-take2", call: CALL, api, store, controllers: f.controllers, now: () => 5, verifyPollMs: 1 });
    await s.prepare();
    s.start("express");
    await flush();
    f.takeover.ended("tko_1");
    await flush();
    expect(store.getState().qa).toMatchObject({ status: "failed", reason: "there is no recording to verify" });
  });

  it("recording end without a pass → call-ended; the takeover controller owns the hold release (rule 8)", async () => {
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
    expect(f.log).toContain("stt.finish");
    expect(log.filter((l) => l.startsWith("release"))).toEqual([]);
    // unmount (in-app navigation) with no pass: the unused hold is released (idempotent server-side), the controller detached
    s.dispose("unmount");
    expect(log.filter((l) => l.startsWith("release"))).toEqual(["release run-case1 tok1 keepalive=true"]);
    expect(f.log).toEqual(expect.arrayContaining(["stt.dispose", "takeover.dispose"]));
  });

  it("pagehide after the start leaves the release to WP5's own pagehide handler and never detaches it early", async () => {
    const { api, log } = fakeApi();
    const f = fakeControllers();
    const s = new CallSession({ callId: "s01-take2", call: CALL, api, store: createConsoleStore(), controllers: f.controllers, now: () => 5 });
    await s.prepare();
    s.start("express");
    await flush();
    s.dispose("pagehide");
    expect(log.filter((l) => l.startsWith("release"))).toEqual([]);
    expect(f.log).not.toContain("takeover.dispose");
    expect(f.log).toContain("stt.dispose");
  });

  it("pagehide before any start releases the run hold with a keepalive fetch", async () => {
    const a = fakeApi();
    const s = new CallSession({ callId: "s01-take2", call: CALL, api: a.api, store: createConsoleStore(), controllers: null, now: () => 5 });
    await s.prepare();
    s.dispose("pagehide");
    expect(a.log.at(-1)).toBe("release run-case1 tok1 keepalive=true");
  });

  it("without controllers (no Web Audio), Start explains instead of failing silently", async () => {
    const store = createConsoleStore();
    const s = new CallSession({ callId: "s01-take2", call: CALL, api: fakeApi().api, store, controllers: null, now: () => 5 });
    await s.prepare();
    s.start("express");
    expect(store.getState().phase).toBe("error");
    expect(store.getState().error?.message).toMatch(/not available/);
  });
});
