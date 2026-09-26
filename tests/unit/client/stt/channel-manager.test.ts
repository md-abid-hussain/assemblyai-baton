/**
 * LiveSttChannelManager (DESIGN §5.1.4-§5.1.9, §5.2): feeding from CallPlayer ticks (the real worklet), frame sizes,
 * feed offset, turn ids and call-clock word times, agent_context carry, Begin check, reconnect, inactivity pause,
 * iOS pause/resume, cached fallback, queue, end of recording.
 */
import { describe, expect, it } from "vitest";
import { mulawEncode } from "../../../../src/core/audio";
import { buildSttParams } from "../../../../src/core/aai/stt-params";
import type { CallManifestEntry } from "../../../../src/core/contracts";
import type { CachedTurnsFile } from "../../../../src/core/contracts/eval";
import type { TurnInput } from "../../../../src/core/contracts/turns";
import { TurnInputSchema } from "../../../../src/core/contracts/turns";
import { CallPlayer, type SpanAudioContext } from "../../../../src/client/audio/call-player";
import { CALL_PLAYER_PROCESSOR, CALL_PLAYER_WORKLET_SOURCE } from "../../../../src/client/audio/worklets/call-player.worklet";
import { CachedReplay } from "../../../../src/client/replay/cached-replay";
import { LiveSttChannelManager, p50 } from "../../../../src/client/stt/channel-manager";
import { call as call8k, policy } from "../../contracts/fixtures";
import { loadWorklet } from "../audio/worklet-harness";
import { FakeApi, FakeConnect, flush, grant, Sink } from "./fakes";

const CTX = 48_000;
const call16k: CallManifestEntry = { ...call8k, source: "golden16k", format: { encoding: "pcm_s16le", sampleRate: 16000 } };
const paramsFor = (call: CallManifestEntry) => ({ rep: buildSttParams(call, policy, "rep"), customer: buildSttParams(call, policy, "customer") });

function rigFor(call: CallManifestEntry, seconds = 20) {
  const rig = loadWorklet(CALL_PLAYER_WORKLET_SOURCE, CALL_PLAYER_PROCESSOR, CTX);
  const n = call.format.sampleRate * seconds;
  const pcm = new Int16Array(n).map((_, i) => Math.round(Math.sin(i / 7) * 8000));
  const srcBytes = call.format.encoding === "pcm_mulaw"
    ? { rep: mulawEncode(pcm), customer: mulawEncode(pcm) }
    : { rep: new Uint8Array(pcm.buffer.slice(0)), customer: new Uint8Array(pcm.buffer.slice(0)) };
  const ctx = { sampleRate: CTX, currentTime: 0, destination: {} } as unknown as SpanAudioContext;
  const player = new CallPlayer({ ctx, node: rig.node, duckGain: null, format: call.format, srcBytes });
  return { rig, player, renderMs: (ms: number) => rig.render(Math.round((ms / 1000) * CTX / 128)) };
}

function setup(opts: { call?: CallManifestEntry; strictBegin?: boolean; cached?: CachedTurnsFile; armed?: { tArmMs: number } } = {}) {
  const call = opts.call ?? call8k;
  const api = new FakeApi();
  api.responses = [() => grant(paramsFor(call))];
  const conn = new FakeConnect();
  const sink = new Sink();
  const turns: TurnInput[] = [];
  const caseSync = { enqueue: (t: TurnInput) => turns.push(t) };
  const cached = opts.cached ? new CachedReplay({ caseId: "case_1", sink, caseSync, now: () => 0 }) : null;
  if (cached && opts.cached) void cached.load(opts.cached);
  const mgr = new LiveSttChannelManager({
    api, sink, caseSync, now: () => 0, connect: conn.fn, cached, strictBegin: opts.strictBegin ?? true,
    takeover: () => ({ armed: !!opts.armed, tArmMs: opts.armed?.tArmMs ?? null }),
  });
  const { rig, player, renderMs } = rigFor(call);
  player.onTick((t) => mgr.feed(t));
  const openArgs = { caseId: "case_1", caseToken: "ct", runId: "run_1", call, policy, startOffsetMs: 0, ctxCarry: "last_rep_turn" as const };
  return { call, api, conn, sink, turns, mgr, rig, player, renderMs, openArgs, cached };
}

describe("open + feed", () => {
  it("n=2 token, both sessions live with the server's params, reports opened", async () => {
    const s = setup();
    await expect(s.mgr.open(s.openArgs)).resolves.toBe("live");
    expect(s.api.tokenCalls).toEqual([{ caseId: "case_1", runId: "run_1", n: 2 }]);
    expect(s.mgr.status).toEqual({ rep: "open", customer: "open" });
    expect(s.conn.latest("rep").params).toMatchObject({ encoding: "pcm_mulaw", sample_rate: 8000, mode: "min_latency" });
    expect(s.api.reports.filter((r) => r.event === "opened")).toHaveLength(2);
    expect(s.mgr.metrics.beginChecks.every((b) => b.ok)).toBe(true);
  });

  it("a relay's compiled listening is laid over the server's params (its prompt, its keyterms first, deduped, capped)", async () => {
    // WP7·3 / PLATFORM §7.6: a relay other than the flagship is transcribed with its own vocabulary. The server
    // stays authoritative for model, encoding, languages and the DESIGN §5.1.5 limits (≤ 100 terms, ≤ 50 chars).
    const s = setup();
    const serverTerms = buildSttParams(call8k, policy, "rep").keyterms_prompt ?? [];
    expect(serverTerms.length).toBeGreaterThan(0);
    await s.mgr.open({
      ...s.openArgs,
      listening: {
        keyterms: ["Cedar Hollow Dental", "periodontal scaling", serverTerms[0] as string, "x".repeat(70), "  "],
        prompt: "A dental receptionist takes a booking deposit.",
        languageCodes: ["en"],
        tuning: "telephony_8k",
      },
    });
    const p = s.conn.latest("rep").params as { prompt?: string; keyterms_prompt?: string[]; sample_rate?: number; encoding?: string };
    expect(p.prompt).toBe("A dental receptionist takes a booking deposit.");
    // The relay's terms come first, the server's follow, the duplicate appears once and nothing is over 50 chars.
    expect(p.keyterms_prompt?.slice(0, 3)).toEqual(["Cedar Hollow Dental", "periodontal scaling", serverTerms[0]]);
    expect(p.keyterms_prompt).toContain("x".repeat(50));
    expect(p.keyterms_prompt?.filter((t) => t === serverTerms[0])).toHaveLength(1);
    expect(p.keyterms_prompt?.every((t) => t.trim().length > 0 && t.length <= 50)).toBe(true);
    expect(p.keyterms_prompt!.length).toBeLessThanOrEqual(100);
    // Never the relay's business: the audio contract stays the server's.
    expect(p).toMatchObject({ encoding: "pcm_mulaw", sample_rate: 8000 });
  });

  it("no listening (the flagship, or a server without v2) leaves the server's params untouched", async () => {
    const s = setup();
    await s.mgr.open(s.openArgs);
    expect(s.conn.latest("rep").params).toEqual(buildSttParams(call8k, policy, "rep"));
  });

  it.each([
    ["8 kHz µ-law", call8k, 800],
    ["16 kHz PCM16", call16k, 1600],
  ])("%s: frames are exactly %i B (100 / 50 ms), never outside 50..1000 ms; audio sent = call time, offset < 1 frame", async (_n, call, frameBytes) => {
    const s = setup({ call });
    await s.mgr.open(s.openArgs);
    s.player.start(0);
    s.renderMs(10_000);
    const rep = s.conn.latest("rep");
    expect(rep.frames.length).toBeGreaterThan(90);
    expect(rep.frames.every((f) => f.byteLength === frameBytes)).toBe(true);
    const frameMs = frameBytes / rep.bytesPerMs;
    expect(Math.abs(s.mgr.callMs - rep.audioMs)).toBeLessThan(frameMs);
    expect(s.mgr.metrics.maxFeedOffsetMs.rep).toBeLessThan(1e-6);
    expect(s.mgr.metrics.maxFeedOffsetMs.customer).toBeLessThan(1e-6);
  });

  it("partials and finals: call-clock word times (session ms + base), turn ids, recvMs, agent_context carry", async () => {
    const s = setup();
    s.openArgs.startOffsetMs = 4000; // Express
    await s.mgr.open(s.openArgs);
    s.player.start(4000);
    s.renderMs(3000);
    const rep = s.conn.latest("rep");
    const cus = s.conn.latest("customer");
    rep.turn(0, "What is her date", [[100, 400], [400, 700]], false);
    rep.turn(0, "What is her date of birth?", [[100, 400], [400, 700], [700, 900], [900, 1200], [1200, 1500]], true);
    expect(s.sink.of("stt.partial")).toHaveLength(1);
    expect(s.turns).toHaveLength(1);
    const t = s.turns[0]!;
    expect(TurnInputSchema.safeParse(t).success).toBe(true);
    expect(t.turnId).toBe("rep-0");
    expect(t.source).toBe("stt_live");
    expect(t.startMs).toBeCloseTo(4100, 6);
    expect(t.endMs).toBeCloseTo(5500, 6);
    expect(t.recvMs).toBeCloseTo(s.mgr.callMs, 6);
    expect(t.recvMs).toBeGreaterThan(6900);
    expect(cus.updates).toEqual([{ agent_context: "What is her date of birth?" }]);
    expect(s.mgr.metrics.ctxUpdates).toBe(1);
    // duplicate final ignored; customer final
    rep.turn(0, "What is her date of birth?", [[100, 1500]], true);
    cus.turn(0, "March fourteenth", [[1600, 2000], [2000, 2600]], true);
    expect(s.turns.map((x) => x.turnId)).toEqual(["rep-0", "customer-0"]);
    expect(s.sink.of("stt.final")).toHaveLength(2);
    expect(s.mgr.metrics.finalLatencyMs.rep[0]).toBeCloseTo(t.recvMs - t.endMs, 6);
  });

  it("ctxCarry none: no UpdateConfiguration; late flag when armed and the turn ends after tArm", async () => {
    const s = setup({ armed: { tArmMs: 1000 } });
    await s.mgr.open({ ...s.openArgs, ctxCarry: "none" });
    s.player.start(0);
    s.renderMs(2000);
    s.conn.latest("rep").turn(0, "ok", [[800, 1200]], true);
    expect(s.conn.latest("customer").updates).toHaveLength(0);
    expect(s.turns[0]!.late).toBe(true);
  });

  it("Express seeds agent_context on the customer session at connect", async () => {
    const s = setup();
    await s.mgr.open({ ...s.openArgs, seedAgentContext: "And her date of birth?" });
    expect(s.conn.latest("customer").params.agent_context).toBe("And her date of birth?");
    expect(s.conn.latest("rep").params.agent_context).toBeUndefined();
  });

  it("hasOpenPartial / forceEndpoint", async () => {
    const s = setup();
    await s.mgr.open(s.openArgs);
    s.conn.latest("customer").turn(3, "my zip is", [[10, 50]], false);
    expect(s.mgr.hasOpenPartial("customer")).toBe(true);
    expect(s.mgr.hasOpenPartial("rep")).toBe(false);
    s.mgr.forceEndpoint("customer");
    expect(s.conn.latest("customer").forceEndpoints).toBe(1);
  });
});

describe("Begin check", () => {
  it("strict (dev/CI): mismatch → terminate, E_STT_INPUT, channel cached", async () => {
    const s = setup({ strictBegin: true, cached: cachedFile() });
    s.conn.beginConfig = { model: "universal-streaming-english", mode: "balanced" };
    await expect(s.mgr.open(s.openArgs)).resolves.toBe("denied");
    expect(s.mgr.status).toEqual({ rep: "cached", customer: "cached" });
    expect(s.sink.of("error").map((e) => e.code)).toContain("E_STT_INPUT");
    expect(s.conn.sessions.every((x) => x.terminated)).toBe(true);
    expect(s.sink.of("mode")[0]!.mode).toBe("cached_replay");
  });
  it("production: mismatch → warn and continue live", async () => {
    const s = setup({ strictBegin: false });
    s.conn.beginConfig = { model: "renamed-in-october" };
    await expect(s.mgr.open(s.openArgs)).resolves.toBe("live");
    expect(s.mgr.metrics.beginChecks.every((b) => !b.ok)).toBe(true);
  });
});

describe("errors (§5.1.9)", () => {
  it("retryable close → ONE n=1 reconnect, generation r1, base = reconnect call ms, customer re-seeded; second failure → cached", async () => {
    const s = setup({ cached: cachedFile() });
    s.api.responses = [() => grant(paramsFor(s.call)), () => grant(paramsFor(s.call), ["customer"])];
    await s.mgr.open(s.openArgs);
    s.player.start(0);
    s.renderMs(2000);
    s.conn.latest("rep").turn(0, "Hello there", [[0, 500]], true);
    const first = s.conn.latest("customer");
    first.serverClose(1011, "internal error");
    await flush();
    await flush();
    expect(s.api.tokenCalls[1]).toEqual({ caseId: "case_1", runId: "run_1", n: 1, channel: "customer", reconnect: true });
    const second = s.conn.latest("customer");
    expect(second).not.toBe(first);
    expect(second.params.agent_context).toBe("Hello there");
    expect(s.mgr.status.customer).toBe("open");
    const atReconnect = s.mgr.callMs;
    s.renderMs(1000);
    second.turn(0, "Hi", [[100, 300]], true);
    const t = s.turns.find((x) => x.channel === "customer")!;
    expect(t.turnId).toBe("customer-0-r1");
    expect(t.startMs).toBeGreaterThan(atReconnect);
    expect(t.startMs).toBeLessThan(atReconnect + 200);
    expect(s.sink.of("stt.status").some((e) => e.status === "open" && e.detail?.startsWith("reconnected at 00:02"))).toBe(true);
    // a second transient close: no reconnects left → partially cached
    second.serverClose(1011);
    await flush();
    await flush();
    expect(s.mgr.status).toEqual({ rep: "open", customer: "cached" });
    expect(s.sink.of("mode")[0]!.reason).toMatch(/partially cached/);
  });

  it("3006 inactivity → paused (billed from wall time), resume() reconnects via the offset path", async () => {
    const s = setup();
    s.api.responses = [() => grant(paramsFor(s.call)), () => grant(paramsFor(s.call), ["rep"])];
    await s.mgr.open(s.openArgs);
    s.player.start(0);
    s.renderMs(1000);
    s.conn.latest("rep").serverClose(3006, "Session terminated due to inactivity");
    await flush();
    expect(s.mgr.status.rep).toBe("paused");
    expect(s.sink.of("paused")).toHaveLength(1);
    const closed = s.api.reports.find((r) => r.event === "closed")!;
    expect(closed.closeCode).toBe(3006);
    expect(closed.billedSeconds).toBeGreaterThanOrEqual(0);
    await s.mgr.resume();
    expect(s.api.tokenCalls.at(-1)).toEqual({ caseId: "case_1", runId: "run_1", n: 1, channel: "rep", reconnect: true });
    expect(s.mgr.status.rep).toBe("open");
  });

  it.each([
    [1008, "Invalid API key", "E_STT_AUTH"],
    [3009, "Too many concurrent sessions", "E_STT_RATE"],
    [3007, "Audio chunk duration", "E_STT_INPUT"],
    [3006, "Invalid JSON", "E_STT_INPUT"],
  ])("close %i (%s) → %s, no retry, channel cached", async (code, text, expected) => {
    const s = setup({ cached: cachedFile() });
    await s.mgr.open(s.openArgs);
    s.conn.latest("rep").serverClose(code, text);
    await flush();
    expect(s.sink.of("error").map((e) => e.code)).toContain(expected);
    expect(s.api.tokenCalls).toHaveLength(1);
    expect(s.mgr.status.rep).toBe("cached");
  });

  it("denied token → cached replay (whole call), 'denied'", async () => {
    const s = setup({ cached: cachedFile() });
    s.api.responses = [() => ({ status: "denied", code: "E_MODE_REPLAY_ONLY", message: "replay only", fallback: "cached_turn_replay" })];
    await expect(s.mgr.open(s.openArgs)).resolves.toBe("denied");
    expect(s.mgr.status).toEqual({ rep: "cached", customer: "cached" });
    expect(s.conn.sessions).toHaveLength(0);
  });

  it("connect failure → cached", async () => {
    const s = setup({ cached: cachedFile() });
    s.conn.failNext = Object.assign(new Error("timeout"), { errorCode: "E_STT_TRANSIENT" });
    await expect(s.mgr.open(s.openArgs)).resolves.toBe("live"); // the other channel is live
    expect(Object.values(s.mgr.status).sort()).toEqual(["cached", "open"]);
  });
});

describe("queue, pause/resume, end", () => {
  it("queued → polls with the ticket → granted → live", async () => {
    const s = setup();
    s.api.responses = [() => ({ status: "queued", ticket: "tk1", position: 1, etaMs: 2000, pollMs: 300 }), () => grant(paramsFor(s.call))];
    await expect(s.mgr.open(s.openArgs)).resolves.toBe("queued");
    expect(s.mgr.status).toEqual({ rep: "queued", customer: "queued" });
    await new Promise((r) => setTimeout(r, 350));
    await flush();
    expect(s.api.tokenCalls[1]).toMatchObject({ n: 2, ticket: "tk1" });
    expect(s.mgr.status).toEqual({ rep: "open", customer: "open" });
  });

  it("pause() terminates both cleanly; resume() opens generation r1 at the current call ms", async () => {
    const s = setup();
    await s.mgr.open(s.openArgs);
    s.player.start(0);
    s.renderMs(1500);
    await s.mgr.pause();
    expect(s.mgr.status).toEqual({ rep: "paused", customer: "paused" });
    expect(s.conn.sessions.every((x) => x.terminated)).toBe(true);
    const fedBefore = s.conn.latest("rep").frames.length;
    s.renderMs(1000); // hidden tab: nothing is fed while paused
    expect(s.conn.latest("rep").frames.length).toBe(fedBefore);
    await s.mgr.resume();
    expect(s.api.tokenCalls.at(-1)).toMatchObject({ n: 2, reconnect: true });
    const resumedAt = s.mgr.callMs;
    s.renderMs(1000);
    s.conn.latest("rep").turn(0, "back", [[0, 200]], true);
    expect(s.turns.at(-1)!.turnId).toBe("rep-0-r1");
    expect(s.turns.at(-1)!.startMs).toBeGreaterThanOrEqual(resumedAt - 1);
    expect(s.turns.at(-1)!.startMs).toBeLessThan(resumedAt + 100);
  });

  it("finishAfterSilence: keeps feeding silence 1500 ms after the end, then terminates and reports billed seconds", async () => {
    const s = setup();
    await s.mgr.open(s.openArgs);
    s.player.start(18_000); // 2 s left of the 20 s asset
    let ended = false;
    s.player.onEnded(() => (ended = true));
    s.renderMs(2100);
    expect(ended).toBe(true);
    const done = s.mgr.finishAfterSilence(1500);
    s.renderMs(1600);
    const res = await done;
    expect(res.map((r) => r.channel)).toEqual(["rep", "customer"]);
    expect(res.every((r) => r.billedSeconds !== null)).toBe(true);
    const rep = s.conn.latest("rep");
    const silentTail = rep.frames.slice(-10);
    expect(silentTail.every((f) => f.every((b) => b === 0xff))).toBe(true);
    expect(s.mgr.status).toEqual({ rep: "closed", customer: "closed" });
    expect(s.api.reports.filter((r) => r.event === "closed" && r.billedSeconds !== undefined)).toHaveLength(2);
  });

  it("p50 helper", () => {
    expect(p50([])).toBeNull();
    expect(p50([5, 1, 3])).toBe(3);
    expect(p50([4, 1, 3, 2])).toBe(2);
  });
});

function cachedFile(): CachedTurnsFile {
  const mk = (order: number, text: string, final: boolean, start: number, end: number) => ({
    type: "Turn", turn_order: order, turn_is_formatted: true, end_of_turn: final, transcript: text, end_of_turn_confidence: 0.9,
    words: [{ text, start, end, confidence: 0.9, word_is_final: final }],
  });
  return {
    callId: call8k.callId,
    variant: "pc_ctx",
    transcribedAt: "2026-09-25T10:00:00Z",
    channels: {
      rep: [{ recvMs: 1200, message: mk(0, "Hello", false, 100, 600) }, { recvMs: 1500, message: mk(0, "Hello there", true, 100, 900) }],
      customer: [{ recvMs: 3000, message: mk(0, "Hi", true, 2000, 2400) }],
    },
  };
}
