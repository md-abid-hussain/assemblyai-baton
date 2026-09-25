/**
 * WP7·1 acceptance (G2 wiring, $0): /call's orchestrator over the REAL merged controllers.
 *   WP4  HttpCaseSync + CachedReplay + LiveSttChannelManager (fake STT transport: WP4's FakeApi/FakeConnect; fake fetch)
 *   WP5  TakeoverController (real protocol machine; fake HTTP TakeoverApi)
 *   WP5b VoiceAgentController + LatencyHud (real; WP5b's FakeSocket / fake player + feeder)
 *   WP1  validateFirstUpdate + compileTakeover (the server compile of the fake api is WP1's too)
 * Express prepare → Start → live STT final → store + noteFinal → Pass → arm/compile/VA token → first update → greeting
 * audible → End call → /end → verification poll with the captured takeover token → "✓ Verified from recording".
 */
import { afterEach, describe, expect, it } from "vitest";

import { buildSttParams } from "@/core/aai/stt-params";
import type { ArmRequest, CreateCaseRequest, CreateCaseResponse, EndTakeoverRequest, SessionReport, StartRunRequest, TakeoverEventsRequest, VaTokenRequest } from "@/core/contracts/api";
import type { CaseState } from "@/core/contracts/case";
import { compileTakeover } from "@/core/compiler";
import type { QaResult } from "@/core/contracts/events";
import type { CallManifestEntry } from "@/core/contracts/scenario";
import type { CallPlayback, CallTick } from "@/core/contracts/services";
import type { DrainReport } from "@/core/contracts/takeover";
import { emptyCaseState, S01_POLICY } from "@/client/fixtures/builder";
import { buildS01 } from "@/client/fixtures/s01";
import type { SessionApi } from "@/client/session/api";
import { CallSession, type SessionControllers } from "@/client/session/orchestrator";
import { askForRepInstructions, createHumanHalf, wireTakeover } from "@/client/session/wiring";
import { createConsoleStore } from "@/client/store/store";
import type { TakeoverApi } from "@/client/takeover";

import { FakeApi, FakeConnect, grant } from "../client/stt/fakes";
import { FakeFeeder, FakePlayer, FakeSocket, pcmChunkB64, type Clock } from "../client/va/fakes";

const CALL: CallManifestEntry = {
  callId: "s01-take2", scenarioId: "s01", title: "Add a driver", source: "twilio8k", language: "en", durationMs: 121_000,
  format: { encoding: "pcm_mulaw", sampleRate: 8000 }, publishAudio: true, inEval: true, featured: true, picker: "main",
  decisionPointMs: 106_500, handoff: { lineStartMs: 110_400, lineEndMs: 114_200, acceptStartMs: 114_800, acceptEndMs: 116_000, declined: false },
  recordedAiBundle: null, customerTailPack: null, assets: { rep: "/calls/s01/rep.x.ulaw", customer: "/calls/s01/customer.x.ulaw", peaks: "/calls/s01/peaks.x.json" },
};

const QA: QaResult = {
  provisional: false, reAsked: 0, newlyAsked: 0, pendingConfirmed: 1, verifiedReconfirmed: 0, disclosures: [], clickToFirstAudibleMs: 3900,
  deadAirAfterRepMs: 380, turnLatencyP50Ms: 2100, payment: "unpaid", handedBack: false, aiSeconds: 20, adviceFlags: 0, details: [],
};

/** The s01 fixture's case state just before its pass: a realistic snapshot for WP1's compiler. */
function snapshotBeforePass(): CaseState {
  const log = buildS01();
  let state: CaseState = emptyCaseState("case1");
  for (const e of log) {
    if (e.type === "takeover.phase") break;
    if (e.type === "case.state") state = e.state;
  }
  return { ...state, caseId: "case1" };
}

const until = async (cond: () => boolean, ms = 4000): Promise<void> => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
};

/** Answers the first update like the live server (session.updated + session.ready), then lets the test speak. */
class AutoReadySocket extends FakeSocket {
  override send(data: string): void {
    super.send(data);
    const msg = JSON.parse(data) as { type: string };
    if (msg.type === "session.update" && this.control.filter((m) => m.type === "session.update").length === 1) {
      queueMicrotask(() => {
        this.server({ type: "session.updated", config: {} });
        this.server({ type: "session.ready", session_id: "sess_va_1", config: {} });
      });
    }
  }
}

let intervals: ReturnType<typeof setInterval>[] = [];
afterEach(() => {
  for (const i of intervals) clearInterval(i);
  intervals = [];
});

function world() {
  const log: string[] = [];
  const store = createConsoleStore();
  const snapshot = snapshotBeforePass();
  // ---- the page's HTTP (SessionApi) and the extract route (CaseSync's fetch)
  const api: SessionApi = {
    status: async () => ({ mode: "live", reason: null, notice: null, budgetPctToday: 1, sttQueueDepth: 0, aiHalfAvailable: true, lastChecks: { light: null, full: null }, limits: { sttOpensPerMin: 4, vaMaxConcurrent: 3 }, features: { beCustomer: true, payments: "mock" }, deployId: "dev-wp7" }) as never,
    async createCase(req: CreateCaseRequest): Promise<CreateCaseResponse> {
      log.push(`createCase prefill=${req.prefillUntilMs ?? 0}`);
      return { caseId: "case1", caseToken: "ct1", policy: S01_POLICY, call: CALL, state: emptyCaseState("case1"), assets: CALL.assets!, cachedTurnsUrl: null };
    },
    async startRun(req: StartRunRequest) {
      log.push(`startRun express=${req.express}`);
      return { runId: "run1", caseId: "case1", sttHalf: "live", aiHalf: "live", vaHoldId: "h1", holdExpiresAt: null, reason: null, recordedHandoffMs: null };
    },
    async releaseRun(runId, _t, keepalive) {
      log.push(`page.release ${runId} ${keepalive ? "keepalive" : ""}`);
    },
    async verification(id, token) {
      log.push(`verification ${id} ${token}`);
      return { status: "completed", qa: QA, elapsedMs: 21_900 };
    },
    getJson: async () => null,
  };
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("/api/extract")) {
      const body = JSON.parse(String(init?.body)) as { turn: { turnId: string } };
      log.push(`extract ${body.turn.turnId}`);
      return new Response(JSON.stringify({ state: { ...snapshot, version: snapshot.version + 1 }, events: [], extractMs: 5 }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  // ---- WP4 STT transport
  const sttApi = new FakeApi();
  sttApi.responses = [() => grant({ rep: buildSttParams(CALL, S01_POLICY, "rep"), customer: buildSttParams(CALL, S01_POLICY, "customer") })];
  const connect = new FakeConnect();
  // ---- WP5 takeover routes (#9–#13, #5b, #7)
  const takeoverApi: TakeoverApi = {
    async arm(req: ArmRequest, token: string) {
      log.push(`arm ${req.source} ${token}`);
      return { takeoverId: "tko_1", takeoverToken: "tt_secret_1", leadMs: 900 };
    },
    async compile(id: string, drain: DrainReport, token: string) {
      log.push(`compile ${id} ${token}`);
      return compileTakeover(snapshot, S01_POLICY, { deployId: "dev-wp7", keytermsEnabled: true, payToolMode: "push" });
    },
    async events(_id: string, body: TakeoverEventsRequest) {
      if (body.phase) log.push(`events phase=${body.phase}`);
    },
    async end(id: string, body: EndTakeoverRequest, token: string) {
      log.push(`end ${id} ${body.outcome} ${token}`);
      return { ok: true as const, verificationJobId: "job_1" };
    },
    async vaToken(req: VaTokenRequest, token: string) {
      log.push(`vaToken ${req.attempt} ${token}`);
      return { token: "va_tok", expiresInSeconds: 10, liveSessionId: "ls_va_1" };
    },
    async releaseRun(runId: string) {
      log.push(`wp5.release ${runId}`);
    },
    async reportSession(r: SessionReport) {
      log.push(`report ${r.kind} ${r.event}`);
    },
  };
  // ---- WP4 engine / playback on a real-time clock (the protocol machine's timers are real)
  const clock = { get t() { return performance.now(); }, now: () => performance.now() } as unknown as Clock;
  const players: FakePlayer[] = [];
  const feeders: FakeFeeder[] = [];
  const tickCbs = new Set<(t: CallTick) => void>();
  const endedCbs = new Set<() => void>();
  const pb = { callMs: 0, playing: false };
  const playback = {
    start: (from: number) => {
      log.push(`play.start ${from}`);
      pb.callMs = from;
      pb.playing = true;
    },
    stop: () => {
      if (pb.playing) log.push("play.stop");
      pb.playing = false;
    },
    dispose: () => {},
    get callMs() {
      return pb.callMs;
    },
    onTick: (cb: (t: CallTick) => void) => (tickCbs.add(cb), () => void tickCbs.delete(cb)),
    onEnded: (cb: () => void) => (endedCbs.add(cb), () => void endedCbs.delete(cb)),
    duck: () => {},
    channelEnergyDb: () => -70,
    playSpan: async () => {},
    playHandoffClip: async () => {
      log.push("handoff.clip");
      return { endCtxMs: performance.now() + 300 };
    },
  } as unknown as CallPlayback;
  const tick = () => {
    const bytes = new Uint8Array(400).fill(0xff); // 50 ms of µ-law silence per channel
    const t: CallTick = { callMs: pb.callMs, playing: pb.playing, rep: bytes, customer: bytes };
    for (const cb of [...tickCbs]) cb(t);
    pb.callMs += 50;
  };
  const engine = {
    ctx: {} as AudioContext,
    unlockSync: () => void log.push("unlockSync"),
    whenRunning: async () => true,
    nowMs: () => performance.now(),
    setAudioSession: () => {},
    loadCall: async () => playback,
    createVaOutput: () => {
      const p = new FakePlayer(clock);
      players.push(p);
      return p;
    },
    createFeeder: () => {
      const f = new FakeFeeder(clock);
      feeders.push(f);
      return f;
    },
    openMic: async () => {
      throw new Error("unused");
    },
    playPcm24k: async () => ({ endCtxMs: 0 }),
  };
  const sockets: AutoReadySocket[] = [];
  const controllers: SessionControllers = {
    engine: () => engine as never,
    lifecycle: () => ({ onPause: () => () => {}, onResume: () => () => {}, isIOS: false }),
    createHumanHalf: (c) => createHumanHalf(c, { strictBegin: false, transport: { fetch: fetchImpl, sttApi, sttConnect: connect.fn } }),
    createTakeover: (c) =>
      wireTakeover(c, {
        takeoverApi,
        openSocket: (url) => {
          log.push(`ws ${url.includes("token=va_tok") ? "token-url" : url}`);
          const ws = new AutoReadySocket(url);
          sockets.push(ws);
          queueMicrotask(() => ws.open());
          return ws;
        },
        toolPorts: () => ({ callTool: async () => ({ result: { ok: true } }), pollPayment: async () => { throw new Error("unused"); } }),
      }),
  };
  const session = new CallSession({ callId: "s01-take2", call: CALL, api, store, controllers, now: () => performance.now(), verifyPollMs: 5 });
  return { log, store, session, connect, sttApi, sockets, players, feeders, tick, snapshot };
}

describe("WP7·1: /call over the real WP4 / WP5 / WP5b controllers", () => {
  it("Express → live STT → Pass → Voice Agent greeting → End call → verified QA", async () => {
    const w = world();
    const { session, store, log } = w;
    await session.prepare();
    expect(log.slice(0, 2)).toEqual(["createCase prefill=81500", "startRun express=true"]);

    // ---- Start (Express) — WP4 grants both channels, playback starts at the cut
    session.start("express");
    await until(() => log.includes("play.start 81500"));
    expect(w.sttApi.tokenCalls).toHaveLength(1);
    expect(store.getState().stt.rep.status).toBe("open");
    expect(store.getState().stt.customer.status).toBe("open");
    expect(store.getState().sessionIds).toEqual({ rep: "sess-rep-1", customer: "sess-customer-2" });
    intervals.push(setInterval(w.tick, 50));

    // ---- a live rep final → store transcript + CaseSync /api/extract (+ the takeover's noteFinal via the page sink)
    await until(() => w.connect.latest("rep").frames.length > 0);
    w.connect.latest("rep").turn(0, "So Friday works", [[100, 400], [450, 700], [750, 1000]], true);
    await until(() => log.includes(`extract ${store.getState().human[0]?.turnId ?? "?"}`));
    expect(store.getState().human[0]).toMatchObject({ lane: "rep", source: "live" });
    expect(store.getState().phase).toBe("shadowing");

    // ---- Pass: unlock in the click, WP5 arms → seals (quiet) → drains → compiles → VA token → WP5b first update
    session.pass();
    expect(log.filter((l) => l === "unlockSync")).toHaveLength(2);
    await until(() => w.sockets.length === 1 && w.sockets[0]!.types().includes("session.update"));
    expect(log).toEqual(expect.arrayContaining(["arm manual ct1", "compile tko_1 tt_secret_1", "vaToken 0 tt_secret_1", "ws token-url", "handoff.clip", "play.stop"]));
    const upd = w.sockets[0]!.control.find((m) => m.type === "session.update") as { session: { greeting: string } };
    expect(upd.session.greeting.length).toBeGreaterThan(10);
    expect(w.connect.latest("rep").terminated && w.connect.latest("customer").terminated).toBe(true); // WP5 terminate_stt

    // ---- the greeting becomes audible → GREETING → ACTIVE
    const ws = w.sockets[0]!;
    ws.server({ type: "reply.started", reply_id: "r1" });
    for (let i = 0; i < 3; i++) ws.server({ type: "reply.audio", reply_id: "r1", data: pcmChunkB64(8000) });
    ws.server({ type: "transcript.agent", reply_id: "r1", text: upd.session.greeting });
    ws.server({ type: "reply.done", reply_id: "r1", status: "completed" });
    await until(() => store.getState().takeover.phase === "active");
    // WP5 emits one phase per dispatch: a quiet click goes idle → draining directly; the store starts the pass there
    const tk = store.getState().takeover;
    expect(tk.steps.map((x) => x.phase)).toEqual(expect.arrayContaining(["draining", "compiling", "greeting", "active"]));
    expect(tk.count).toBe(1);
    expect(tk.source).toBe("manual");
    expect(tk.armedT).not.toBeNull();
    expect(tk.tArmMs).toBeGreaterThanOrEqual(81_500); // the CALL clock (detail.tArmMs), not the AudioContext clock
    expect(tk.tArmMs).toBeLessThan(121_000);
    expect(store.getState().phase).toMatch(/^ai-/);

    // ---- Ask for the rep → reply.create with the hand-back instructions
    session.askForDaniel();
    const rc = ws.control.filter((m) => m.type === "reply.create").at(-1) as { instructions?: string } | undefined;
    expect(rc?.instructions ?? JSON.stringify(rc)).toContain(askForRepInstructions(S01_POLICY.repFirstName).slice(0, 40));

    // ---- End call → session.end → ended → /end → verification poll with the captured takeover token
    session.endCall();
    await until(() => store.getState().qa.status === "verified", 6000);
    expect(ws.types()).toContain("session.end");
    expect(log).toEqual(expect.arrayContaining(["end tko_1 abandoned tt_secret_1", "verification tko_1 tt_secret_1"]));
    expect(store.getState().qa.verified?.pendingConfirmed).toBe(1);
    // the page never released the run itself: WP5 owns it once the takeover exists
    expect(log.some((l) => l.startsWith("page.release"))).toBe(false);
    session.dispose("unmount");
  }, 15_000);
});
