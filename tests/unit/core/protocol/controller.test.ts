/**
 * TakeoverController (src/client/takeover) with fakes for every collaborator: the effects of the pure machine reach
 * playback, STT, CaseSync, the HTTP API and the Voice Agent in the right order, and their results come back.
 * (Kept under tests/unit/core/protocol, WP5's test folder; the controller is the machine's executor.)
 */
import { describe, expect, it } from "vitest";

import type { ArmRequest, EndTakeoverRequest, SessionReport, TakeoverEventsRequest, VaTokenRequest } from "../../../../src/core/contracts/api";
import type { Channel } from "../../../../src/core/contracts/case";
import type { BatonEvent } from "../../../../src/core/contracts/events";
import type { CallTick } from "../../../../src/core/contracts/services";
import { TAKEOVER_TIMING as T, type CompiledTakeover, type DrainReport } from "../../../../src/core/contracts/takeover";
import { HttpTakeoverApi } from "../../../../src/client/takeover/api";
import { TakeoverControllerImpl } from "../../../../src/client/takeover/controller";
import { TakeoverApiError, type TakeoverApi, type TakeoverControllerDeps, type VaSession, type VaSessionEvent } from "../../../../src/client/takeover/ports";
import { compiledFixture, HANDOFF } from "./_harness";

const flush = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};

function deferred<V>() {
  let resolve!: (v: V) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<V>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

class FakeVa implements VaSession {
  cbs = new Set<(e: VaSessionEvent) => void>();
  log: string[] = [];
  started: { compiled: CompiledTakeover; hold: number } | null = null;
  constructor(readonly attempt: 0 | 1) {}
  async connect(token: string) {
    this.log.push(`connect:${token}`);
  }
  async start(c: CompiledTakeover, o: { holdAudioUntilCtxMs: number }) {
    this.started = { compiled: c, hold: o.holdAudioUntilCtxMs };
    this.log.push("start");
    return { sessionId: `sess_${this.attempt}` };
  }
  async end(reason: string) {
    this.log.push(`end:${reason}`);
    queueMicrotask(() => this.emit({ type: "ended", reason, sessionSeconds: 61.5, sessionId: `sess_${this.attempt}` }));
  }
  endNow(reason: string) {
    this.log.push(`endNow:${reason}`);
  }
  onEvent(cb: (e: VaSessionEvent) => void) {
    this.cbs.add(cb);
    return () => this.cbs.delete(cb);
  }
  emit(e: VaSessionEvent) {
    for (const cb of [...this.cbs]) cb(e);
  }
}

function world(o: { aiHalf?: "live" | "recorded"; recorded?: boolean; autoBaton?: boolean } = {}) {
  const clock = { t: 100_000 };
  const timers: { at: number; fn: () => void; id: number }[] = [];
  let tid = 0;
  const calls: string[] = [];
  const energy: Record<Channel, number> = { rep: -60, customer: -60 };
  const partial: Record<Channel, boolean> = { rep: false, customer: false };
  const tickCbs = new Set<(t: CallTick) => void>();
  const endedCbs = new Set<() => void>();
  const vas: FakeVa[] = [];
  const sink: BatonEvent[] = [];
  let pageHide: (() => void) | null = null;
  const hooks = {
    events: null as null | (() => Promise<void>),
    compile: null as null | (() => Promise<CompiledTakeover>),
    vaToken: null as null | ((r: VaTokenRequest) => Promise<{ token: string; expiresInSeconds: number; liveSessionId: string }>),
  };
  const recorded = { plays: 0, stops: 0, done: deferred<void>() };
  const api: TakeoverApi = {
    async arm(req: ArmRequest) {
      calls.push(`arm:${req.source}:${req.tArmMs}:${req.midUtterance}`);
      return { takeoverId: "tko_1", takeoverToken: "tt_1", leadMs: 900 };
    },
    async compile(id: string, drain: DrainReport) {
      calls.push(`compile:${id}:${drain.tArmMs}`);
      return hooks.compile ? hooks.compile() : compiledFixture();
    },
    async events(id: string, body: TakeoverEventsRequest, _tok: string) {
      calls.push(`events:${JSON.stringify(Object.keys(body).sort())}${body.failure ? `:${body.failure.code}` : ""}`);
      if (hooks.events) await hooks.events();
    },
    async end(id: string, body: EndTakeoverRequest, _tok: string, opts?: { keepalive?: boolean }) {
      calls.push(`end:${body.outcome}:${body.reason ?? ""}${opts?.keepalive ? ":keepalive" : ""}`);
      return { ok: true as const, verificationJobId: "job_9" };
    },
    async vaToken(req: VaTokenRequest) {
      calls.push(`vaToken:${req.attempt}`);
      return hooks.vaToken ? hooks.vaToken(req) : { token: `vt${req.attempt}`, expiresInSeconds: 10, liveSessionId: `va_tko_1_${req.attempt}` };
    },
    async releaseRun(runId: string, _tok: string, opts?: { keepalive?: boolean }) {
      calls.push(`release:${runId}${opts?.keepalive ? ":keepalive" : ""}`);
    },
    async reportSession(r: SessionReport) {
      calls.push(`report:${r.kind}:${r.event}:${r.sessionId}${r.billedSeconds !== undefined ? `:${r.billedSeconds}` : ""}`);
    },
  };
  const deps: TakeoverControllerDeps = {
    ids: { caseId: "case_1", runId: "run_1", caseToken: "ct" },
    aiHalf: o.aiHalf ?? "live",
    call: { handoff: HANDOFF, recordedAiBundle: o.recorded === false ? null : "/replays/s01/" },
    autoBaton: o.autoBaton ?? true,
    engine: { nowMs: () => clock.t },
    playback: {
      stop: (ms?: number) => void calls.push(`stop:${ms}`),
      channelEnergyDb: (ch: Channel) => energy[ch],
      playHandoffClip: async () => {
        calls.push("clip");
        return { endCtxMs: clock.t + 3500 };
      },
      onTick: (cb) => {
        tickCbs.add(cb);
        return () => tickCbs.delete(cb);
      },
      onEnded: (cb) => {
        endedCbs.add(cb);
        return () => endedCbs.delete(cb);
      },
    },
    stt: {
      hasOpenPartial: (ch: Channel) => partial[ch],
      forceEndpoint: (ch: Channel) => void calls.push(`force:${ch}`),
      terminateAll: async () => {
        calls.push("terminate");
        return [];
      },
    },
    caseSync: {
      drain: async (timeoutMs: number) => {
        calls.push(`drain:${timeoutMs}`);
        return { completedTurnIds: ["rep-3"], pendingTurnIds: [], waitedMs: 80 };
      },
    },
    api,
    createVa: (attempt, ctx) => {
      const v = new FakeVa(attempt);
      vas.push(v);
      calls.push(`createVa:${attempt}:${ctx.takeoverId}:${ctx.takeoverToken}`);
      return v;
    },
    localCompile: () => {
      calls.push("localCompile");
      return { ...compiledFixture(), compiledBy: "client" };
    },
    recorded: o.recorded === false ? null : {
      play: () => {
        recorded.plays++;
        return recorded.done.promise;
      },
      stop: () => void recorded.stops++,
    },
    playRepBack: async () => void calls.push("repBack"),
    sink: { emit: (e) => void sink.push(e) },
    hud: { mark: (name, ctxMs) => void calls.push(`hud:${name}:${ctxMs}`) },
    onPageHide: (cb) => {
      pageHide = cb;
      return () => (pageHide = null);
    },
    timers: {
      setTimeout: (fn, ms) => {
        const id = ++tid;
        timers.push({ at: clock.t + ms, fn, id });
        return id;
      },
      clearTimeout: (h) => {
        const i = timers.findIndex((x) => x.id === h);
        if (i >= 0) timers.splice(i, 1);
      },
    },
  };
  const ctl = new TakeoverControllerImpl(deps);
  let callMs = 60_000;
  const w = {
    ctl, calls, energy, partial, vas, sink, clock, recorded, hooks, deps,
    tick(o2: { callMs?: number; playing?: boolean } = {}) {
      if (o2.callMs !== undefined) callMs = o2.callMs;
      for (const cb of [...tickCbs]) cb({ callMs, playing: o2.playing ?? true, rep: new Uint8Array(0), customer: new Uint8Array(0) });
    },
    async advance(ms: number) {
      const target = clock.t + ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at);
        const next = timers[0];
        if (!next || next.at > target) break;
        timers.shift();
        clock.t = Math.max(clock.t, next.at);
        next.fn();
        await flush();
      }
      clock.t = target;
      await flush();
    },
    ended: () => [...endedCbs].forEach((cb) => cb()),
    pagehide: () => pageHide?.(),
    phases: () => sink.filter((e): e is Extract<BatonEvent, { type: "takeover.phase" }> => e.type === "takeover.phase").map((e) => e.phase),
    idx: (prefix: string) => calls.findIndex((c) => c.startsWith(prefix)),
  };
  return w;
}

/** Click while the rep speaks, then silence; returns once the controller is in GREETING. */
async function toGreeting(w: ReturnType<typeof world>) {
  w.energy.rep = -20;
  w.partial.rep = true;
  w.tick({ callMs: 60_000 });
  await w.ctl.arm("manual");
  await flush(); // arm_ok → vaToken(0) → connect → va_open
  w.energy.rep = -60;
  w.clock.t += 300;
  w.tick({ callMs: 60_300 }); // quiet with an open partial → SEALING
  await flush(); // clip scheduled
  await w.advance(T.SEAL_TAIL_MS); // force endpoint
  w.partial.rep = false;
  w.tick({ callMs: 60_560, playing: false }); // partials closed → DRAINING
  await flush(); // drained → compile → compiled → CONNECTING
  await w.advance(4000); // tSend = repLineEnd − 900
}

describe("TakeoverController: the manual pass end to end (fakes)", () => {
  it("arm → seal → force endpoint → drain → compile → tSend → greeting → active → close → done, in order", async () => {
    const w = world();
    await toGreeting(w);
    expect(w.ctl.phase).toBe("greeting");
    // the protocol's own sequence (the VA token and pre-open interleave freely, but before the first update)
    const order = ["arm:manual:60000:true", "stop:30", "clip", "force:rep", "drain:2000", "terminate", "compile:tko_1:60000"];
    const idxs = order.map((c) => w.idx(c));
    expect(idxs.every((i) => i >= 0)).toBe(true);
    expect([...idxs].sort((a, b) => a - b)).toEqual(idxs);
    expect(w.idx("vaToken:0")).toBeGreaterThan(w.idx("arm:"));
    expect(w.idx("createVa:0:tko_1:tt_1")).toBeLessThan(w.idx("compile:"));
    const va = w.vas[0]!;
    expect(va.log).toEqual(["connect:vt0", "start"]);
    const repLineEnd = w.ctl.state.pass!.repLineEnd!;
    expect(va.started?.hold).toBe(repLineEnd);
    expect(w.ctl.state.pass!.timings.sessionUpdateSent).toBe(repLineEnd - 900 - w.ctl.state.pass!.t0);

    va.emit({ type: "ready", sessionId: "sess_0", ctxMs: w.clock.t });
    await flush();
    expect(w.calls).toContain("report:va:opened:va_tko_1_0");
    w.clock.t = repLineEnd + 250;
    va.emit({ type: "first_audible", replyId: "r1", ctxMs: w.clock.t, greeting: true });
    await flush();
    expect(w.ctl.phase).toBe("active");
    expect(w.calls).toContain('events:["phase","timings","vaSessionId"]');

    va.emit({ type: "paying", on: true });
    expect(w.ctl.phase).toBe("paying");
    va.emit({ type: "paying", on: false });
    va.emit({ type: "close_ready" });
    await flush();
    expect(va.log).toContain("end:close_ready");
    await flush();
    expect(w.ctl.phase).toBe("done");
    // report closed (billed seconds) strictly before /end
    const rep = w.idx("report:va:closed:va_tko_1_0:61.5");
    const end = w.idx("end:completed:close_ready");
    expect(rep).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(rep);
    expect(w.ctl.view().verificationJobId).toBe("job_9");
    expect(w.phases()).toEqual(["armed", "sealing", "draining", "compiling", "connecting", "greeting", "active", "paying", "active", "closing", "done"]);
    expect(w.calls.filter((c) => c.startsWith("hud:")).map((c) => c.split(":")[1])).toEqual(["arm", "repLineStart", "repLineEnd"]);
  });

  it("GREETING retry: abort the old socket, POST {failure} BEFORE minting attempt 1, same compiled config", async () => {
    const w = world();
    await toGreeting(w);
    const gate = deferred<void>();
    w.hooks.events = () => gate.promise;
    const va0 = w.vas[0]!;
    const compiled = va0.started!.compiled;
    va0.emit({ type: "error", code: "E_VA_TRANSIENT", retryable: true, message: "server_error", afterFirstUpdate: true });
    await flush();
    expect(w.ctl.phase).toBe("retrying");
    expect(va0.log).toContain("endNow:E_VA_TRANSIENT");
    expect(w.calls).toContain('events:["failure"]:E_VA_TRANSIENT');
    expect(w.calls).not.toContain("vaToken:1"); // waits for last_failure_at
    gate.resolve();
    await flush();
    expect(w.calls).toContain("vaToken:1");
    const va1 = w.vas[1]!;
    expect(va1.log).toEqual(["connect:vt1", "start"]);
    expect(va1.started?.compiled).toBe(compiled);
    // the old socket is unsubscribed: its late events change nothing
    va0.emit({ type: "ready", sessionId: "old", ctxMs: 0 });
    expect(w.ctl.state.pass!.va.sessionId).toBeNull();
    va1.emit({ type: "ready", sessionId: "sess_1", ctxMs: w.clock.t });
    va1.emit({ type: "first_audible", replyId: "r", ctxMs: w.clock.t + 10, greeting: true });
    await flush();
    expect(w.ctl.phase).toBe("active");
    expect(w.ctl.view().pass?.attempt).toBe(1);
  });

  it("a second failure plays the recorded AI session (labelled) and ends the takeover failed", async () => {
    const w = world();
    await toGreeting(w);
    w.vas[0]!.emit({ type: "error", code: "E_VA_AUTH", retryable: true, message: "unauthorized", afterFirstUpdate: true });
    await flush();
    w.vas[1]!.emit({ type: "error", code: "E_VA_TRANSIENT", retryable: true, message: "again", afterFirstUpdate: true });
    await flush();
    expect(w.ctl.phase).toBe("fallback");
    expect(w.recorded.plays).toBe(1);
    expect(w.sink).toContainEqual(expect.objectContaining({ type: "fallback", kind: "recorded_ai_session" }));
    expect(w.sink).toContainEqual(expect.objectContaining({ type: "mode", mode: "recorded_ai" }));
    expect(w.calls.some((c) => c.startsWith("end:failed:E_VA_TRANSIENT"))).toBe(true);
    expect(w.calls.filter((c) => c.startsWith("vaToken:"))).toEqual(["vaToken:0", "vaToken:1"]);
    w.recorded.done.resolve();
    await flush();
    expect(w.ctl.phase).toBe("done");
  });

  it("the server compile times out → local compile after 1500 ms", async () => {
    const w = world();
    w.hooks.compile = () => new Promise(() => undefined);
    w.energy.rep = -20;
    w.tick({ callMs: 60_000 });
    await w.ctl.arm("manual");
    await flush();
    w.energy.rep = -60;
    w.tick({ callMs: 60_400 });
    await flush();
    expect(w.ctl.phase).toBe("compiling");
    expect(w.calls).not.toContain("localCompile");
    await w.advance(T.COMPILE_TIMEOUT_MS);
    expect(w.calls).toContain("localCompile");
    expect(w.ctl.view().pass?.compiledBy).toBe("client");
    expect(["connecting", "greeting"]).toContain(w.ctl.phase);
  });

  it("pagehide mid-session: session.end now, keepalive /end, STT terminate and keepalive run release", async () => {
    const w = world();
    await toGreeting(w);
    w.vas[0]!.emit({ type: "ready", sessionId: "sess_0", ctxMs: w.clock.t });
    w.pagehide();
    await flush();
    expect(w.vas[0]!.log).toContain("endNow:pagehide");
    expect(w.calls).toContain("end:abandoned:pagehide:keepalive");
    expect(w.calls).toContain("release:run_1:keepalive");
    // inert afterwards
    await w.ctl.arm("manual");
    expect(w.calls.filter((c) => c.startsWith("arm:"))).toHaveLength(1);
  });

  it("pagehide while shadowing releases the run and terminates STT", async () => {
    const w = world();
    w.tick({ callMs: 1000 });
    w.pagehide();
    await flush();
    expect(w.calls).toEqual(expect.arrayContaining(["terminate", "release:run_1:keepalive"]));
  });
});

describe("TakeoverController: auto-baton, recorded half, end of recording", () => {
  it("arms automatically at the recorded handoff line", async () => {
    const w = world();
    w.tick({ callMs: HANDOFF.lineStartMs - 20 });
    expect(w.calls.some((c) => c.startsWith("arm:"))).toBe(false);
    w.tick({ callMs: HANDOFF.lineStartMs + 20 });
    await flush();
    expect(w.calls).toContain(`arm:auto_handoff:${HANDOFF.lineStartMs}:false`);
    expect(w.ctl.phase).toBe("armed");
    w.tick({ callMs: HANDOFF.acceptEndMs! });
    await flush();
    expect(w.calls).not.toContain("clip");
    expect(w.calls).toContain("stop:30");
  });

  it("recorded runs never arm manually; the recorded session plays after the acceptance", async () => {
    const w = world({ aiHalf: "recorded" });
    w.tick({ callMs: 30_000 });
    expect(w.ctl.manualPassAllowed).toBe(false);
    await w.ctl.arm("manual");
    await flush();
    expect(w.calls.some((c) => c.startsWith("arm:"))).toBe(false);
    expect(w.ctl.view().notice?.level).toBe("info");
    w.tick({ callMs: HANDOFF.acceptEndMs! + 5 });
    await flush();
    expect(w.recorded.plays).toBe(1);
    expect(w.ctl.phase).toBe("fallback");
  });

  it("the end of the recording without a pass releases the run", async () => {
    const w = world({ autoBaton: false });
    w.tick({ callMs: 200_000 });
    w.ended();
    await flush();
    expect(w.calls).toContain("release:run_1");
  });

  it("an arm refused by the server returns to shadowing with an error notice", async () => {
    const w = world();
    w.deps.api.arm = async () => {
      throw new TakeoverApiError("E_RATE_LIMITED", 429, "A call allows 3 passes of the baton.");
    };
    w.energy.rep = -20;
    w.tick({ callMs: 50_000 });
    await w.ctl.arm("manual");
    await flush();
    expect(w.ctl.phase).toBe("idle");
    expect(w.ctl.view().notice).toMatchObject({ level: "error", code: "E_RATE_LIMITED" });
    expect(w.sink).toContainEqual(expect.objectContaining({ type: "error", code: "E_RATE_LIMITED" }));
  });

  it("noteFinal marks the cut turn and armInfo feeds WP4's late flag", async () => {
    const w = world();
    w.energy.customer = -15;
    w.partial.customer = true;
    w.tick({ callMs: 70_000 });
    await w.ctl.arm("manual");
    expect(w.ctl.armInfo()).toEqual({ armed: true, tArmMs: 70_000 });
    w.tick({ callMs: 71_000 });
    await w.advance(T.ARM_TURN_END_MAX_MS); // cap while the customer still speaks
    expect(w.ctl.state.pass!.capHit).toBe(true);
    w.ctl.noteFinal({ turnId: "customer-9", channel: "customer", startMs: 69_000, endMs: 71_300 });
    expect(w.ctl.state.pass!.cutTurnIds).toEqual(["customer-9"]);
  });
});

describe("HttpTakeoverApi", () => {
  function fakeFetch(respond: (url: string, init: RequestInit) => Response) {
    const seen: { url: string; init: RequestInit }[] = [];
    const f = (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(url), init: init ?? {} });
      return respond(String(url), init ?? {});
    }) as typeof fetch;
    return { f, seen };
  }

  it("posts with the bearer token and the visitor header; keepalive on pagehide", async () => {
    const { f, seen } = fakeFetch((url) =>
      url.endsWith("/end") ? new Response(JSON.stringify({ ok: true, verificationJobId: "j" })) : new Response(JSON.stringify({ takeoverId: "t", takeoverToken: "tt", leadMs: 800 })),
    );
    const api = new HttpTakeoverApi({ fetch: f, visitorToken: () => "vtok" });
    expect(await api.arm({ caseId: "c", runId: "r", tArmMs: 1.5, midUtterance: false, source: "manual" }, "ct")).toEqual({ takeoverId: "t", takeoverToken: "tt", leadMs: 800 });
    const h = seen[0]!.init.headers as Record<string, string>;
    expect(seen[0]!.url).toBe("/api/takeovers");
    expect(h.authorization).toBe("Bearer ct");
    expect(h["x-baton-visitor"]).toBe("vtok");
    expect(await api.end("t/1", { outcome: "abandoned", vaSessionId: null, reason: "pagehide" }, "tt", { keepalive: true })).toEqual({ ok: true, verificationJobId: "j" });
    expect(seen[1]!.url).toBe("/api/takeovers/t%2F1/end");
    expect(seen[1]!.init.keepalive).toBe(true);
    expect(seen[1]!.init.signal).toBeUndefined();
  });

  it("maps ApiError bodies to TakeoverApiError (code, status, fallback) and network errors to a transport code", async () => {
    const { f } = fakeFetch(() => new Response(JSON.stringify({ error: { code: "E_CASE_STATE", message: "recorded run", fallback: "recorded_ai_session" } }), { status: 409 }));
    const api = new HttpTakeoverApi({ fetch: f });
    const e = await api.vaToken({ takeoverId: "t", attempt: 0 }, "tt").catch((x: unknown) => x);
    expect(e).toBeInstanceOf(TakeoverApiError);
    expect(e).toMatchObject({ code: "E_CASE_STATE", status: 409, fallback: "recorded_ai_session" });
    const broken = new HttpTakeoverApi({ fetch: (async () => { throw new TypeError("offline"); }) as typeof fetch });
    expect(await broken.releaseRun("r", "ct").catch((x: unknown) => (x as TakeoverApiError).code)).toBe("E_VA_TRANSIENT");
    const html = new HttpTakeoverApi({ fetch: (async () => new Response("<html>", { status: 502 })) as typeof fetch });
    expect(await html.events("t", { heartbeat: true }, "tt").catch((x: unknown) => (x as TakeoverApiError).code)).toBe("E_INTERNAL");
  });
});
