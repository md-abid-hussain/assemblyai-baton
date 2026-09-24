/**
 * src/core/aai/voice-agent.ts: VoiceAgentSession, ToolDispatcher, ReplyTracker, RealtimeAudioFeeder and the helpers,
 * against an in-memory fake socket (no network, no AssemblyAI session).
 */
import { describe, expect, it } from "vitest";
import {
  RealtimeAudioFeeder, SessionError, VA_VOICES, VoiceAgentSession, bytesToBase64, chunkLevelDb, errorCode, tokenUrl,
  vaErrorToErrorCode, type ClientEvent, type ReplyInfo, type WebSocketLike,
} from "../../../../src/core/aai/voice-agent";
import { mulawEncode, pcm16ToBytes } from "../../../../src/core/audio";

type Listener = (ev: never) => void;

class FakeVaSocket implements WebSocketLike {
  readyState = 1;
  readonly sent: ClientEvent[] = [];
  private listeners = new Map<string, Set<Listener>>();
  /** Scripted replies to client events. */
  onClientEvent: (ev: ClientEvent, sock: FakeVaSocket) => void = () => undefined;
  addEventListener(type: string, fn: Listener): void {
    let set = this.listeners.get(type);
    if (!set) this.listeners.set(type, (set = new Set()));
    set.add(fn);
  }
  send(data: string): void {
    const ev = JSON.parse(data) as ClientEvent;
    this.sent.push(ev);
    this.onClientEvent(ev, this);
  }
  close(code = 1000, reason = ""): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    for (const fn of this.listeners.get("close") ?? []) (fn as (e: { code: number; reason: string }) => void)({ code, reason });
  }
  deliver(ev: Record<string, unknown>, binary = false): void {
    const text = JSON.stringify(ev);
    const data = binary ? new TextEncoder().encode(text) : text;
    for (const fn of this.listeners.get("message") ?? []) (fn as (e: { data: unknown }) => void)({ data });
  }
  sentOf<T extends ClientEvent["type"]>(type: T): Extract<ClientEvent, { type: T }>[] {
    return this.sent.filter((e): e is Extract<ClientEvent, { type: T }> => e.type === type);
  }
}

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const pcm = (amp: number, ms: number) => pcm16ToBytes(new Int16Array((24000 * ms) / 1000).map((_, i) => Math.round(amp * Math.sin(i / 3))));

function readySession(): { s: VoiceAgentSession; sock: FakeVaSocket } {
  const sock = new FakeVaSocket();
  sock.onClientEvent = (ev, so) => {
    if (ev.type === "session.update") {
      setTimeout(() => {
        so.deliver({ type: "session.updated", config: {} });
        so.deliver({ type: "session.ready", session_id: "sess_1", config: { output: { format: { encoding: "audio/pcm", sample_rate: 24000 } } } });
      }, 1);
    }
    if (ev.type === "session.end") setTimeout(() => {
      so.deliver({ type: "session.ended", session_duration_seconds: 12 });
      so.close(1000, "");
    }, 1);
  };
  return { s: new VoiceAgentSession(sock), sock };
}

describe("VoiceAgentSession", () => {
  it("start() sends the first session.update and resolves on session.ready; end() is clean", async () => {
    const { s, sock } = readySession();
    const ready = await s.start({ system_prompt: "p", greeting: "Hi", output: { voice: "alba" } });
    expect(ready.session_id).toBe("sess_1");
    expect(s.sessionId).toBe("sess_1");
    expect(sock.sent[0]).toEqual({ type: "session.update", session: { system_prompt: "p", greeting: "Hi", output: { voice: "alba" } } });
    s.sendAudio(new Uint8Array([1, 2, 3]));
    expect(sock.sentOf("input.audio")[0]!.audio).toBe(bytesToBase64(new Uint8Array([1, 2, 3])));
    s.replyNow("Please continue.");
    expect(sock.sentOf("reply.create")[0]).toEqual({ type: "reply.create", instructions: "Please continue." });
    const ended = await s.end(500);
    expect(ended?.session_duration_seconds).toBe(12);
    expect(s.isOpen).toBe(false);
    expect(s.timeline.map((t) => t.type)).toEqual(["session.updated", "session.ready", "session.ended"]);
  });

  it("start() rejects with the session.error of a bad first update", async () => {
    const sock = new FakeVaSocket();
    sock.onClientEvent = (_ev, so) => setTimeout(() => {
      so.deliver({ type: "session.error", code: "INVALID_VALUE", message: "voice ivy is invalid", param: "output.voice" });
      so.close(1008, "");
    }, 1);
    const s = new VoiceAgentSession(sock);
    const err = await s.start({ output: { voice: "ivy" } }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SessionError);
    expect((err as SessionError).code).toBe("invalid_value");
    expect(vaErrorToErrorCode((err as SessionError).event, { afterFirstUpdate: true })).toBe("E_VA_CONFIG");
  });

  it("decodes binary text frames (Node ws) and endNow() sends session.end synchronously", async () => {
    const { s, sock } = readySession();
    const seen: string[] = [];
    s.on("*", (e) => seen.push(e.type));
    sock.deliver({ type: "input.speech.started" }, true);
    expect(seen).toEqual(["input.speech.started"]);
    s.endNow();
    expect(sock.sentOf("session.end")).toHaveLength(1);
    expect(sock.readyState).toBe(3);
  });

  it("the client-side cap (maxDurationMs) ends the session", async () => {
    const sock = new FakeVaSocket();
    sock.onClientEvent = (ev, so) => {
      if (ev.type === "session.end") setTimeout(() => so.close(1000, ""), 1);
    };
    const s = new VoiceAgentSession(sock, { maxDurationMs: 20 });
    await tick(80);
    expect(sock.sentOf("session.end")).toHaveLength(1);
    expect(s.closed?.code).toBe(1000);
  });
});

describe("ToolDispatcher", () => {
  it('"immediate" sends tool.result as soon as the handler returns; unknown tools get is_error', async () => {
    const { s, sock } = readySession();
    s.tools.policy = "immediate";
    s.tools.register("get_disclosure", async (args) => ({ ok: true, kind: args.kind }));
    sock.deliver({ type: "reply.started", reply_id: "r1" });
    sock.deliver({ type: "tool.call", call_id: "c1", name: "get_disclosure", arguments: { kind: "premium_change" } });
    sock.deliver({ type: "tool.call", call_id: "c2", name: "nope", arguments: {} });
    await tick(5);
    const results = sock.sentOf("tool.result");
    expect(results.find((r) => r.call_id === "c1")).toEqual({ type: "tool.result", call_id: "c1", result: JSON.stringify({ ok: true, kind: "premium_change" }) });
    expect(results.find((r) => r.call_id === "c2")?.is_error).toBe(true);
  });

  it('defaults to "immediate" (golden config, DESIGN §5.9.4)', () => {
    expect(readySession().s.tools.policy).toBe("immediate");
  });

  it('"reply_done" holds results until reply.done; interrupted replies drop them', async () => {
    const { s, sock } = readySession();
    s.tools.policy = "reply_done";
    s.tools.register("update_case_field", () => ({ result: "accepted" }));
    sock.deliver({ type: "reply.started", reply_id: "r1" });
    sock.deliver({ type: "tool.call", call_id: "c1", name: "update_case_field", arguments: {} });
    await tick(5);
    expect(sock.sentOf("tool.result")).toHaveLength(0);
    sock.deliver({ type: "reply.done", reply_id: "r1", status: "completed" });
    expect(sock.sentOf("tool.result")).toHaveLength(1);

    sock.deliver({ type: "reply.started", reply_id: "r2" });
    sock.deliver({ type: "tool.call", call_id: "c2", name: "update_case_field", arguments: {} });
    await tick(5);
    sock.deliver({ type: "reply.done", reply_id: "r2", status: "interrupted" });
    expect(sock.sentOf("tool.result")).toHaveLength(1);
    expect(s.tools.traces.find((t) => t.call.call_id === "c2")?.dropped).toBe("interrupted");
  });

  it("a held result survives an interrupted LATER reply (reassurance barge-in during the pay hold)", async () => {
    const { s, sock } = readySession();
    let pay!: (v: unknown) => void;
    s.tools.register("send_esign_and_pay_link", () => new Promise((r) => (pay = r)));
    // r1: the silent pre-amble that carries the hold tool.call, completes normally.
    sock.deliver({ type: "reply.started", reply_id: "r1" });
    sock.deliver({ type: "tool.call", call_id: "hold1", name: "send_esign_and_pay_link", arguments: { customer_agreed_to_text: true } });
    sock.deliver({ type: "reply.done", reply_id: "r1", status: "completed" });
    // r2: a reassurance reply.create the customer barges into.
    sock.deliver({ type: "reply.started", reply_id: "r2" });
    sock.deliver({ type: "input.speech.started" });
    sock.deliver({ type: "reply.done", reply_id: "r2", status: "interrupted" });
    await tick(5);
    expect(sock.sentOf("tool.result")).toHaveLength(0);
    pay({ status: "paid", amount: "$23.40", receipt: "PAY-1", verified_by: "polar_webhook" });
    await tick(5);
    const sent = sock.sentOf("tool.result");
    expect(sent).toHaveLength(1);
    expect(sent[0]?.call_id).toBe("hold1");
    expect(s.tools.traces.find((t) => t.call.call_id === "hold1")).toMatchObject({ replyId: "r1" });
    expect(s.tools.traces.find((t) => t.call.call_id === "hold1")?.dropped).toBeUndefined();
  });

  it("drops a pending result when ITS reply is interrupted, but not one from another reply", async () => {
    const { s, sock } = readySession();
    const resolvers: Record<string, (v: unknown) => void> = {};
    s.tools.register("update_case_field", (_a, call) => new Promise((r) => (resolvers[call.call_id] = r)));
    sock.deliver({ type: "reply.started", reply_id: "r1" });
    sock.deliver({ type: "tool.call", call_id: "a", name: "update_case_field", arguments: {} });
    sock.deliver({ type: "reply.done", reply_id: "r1", status: "completed" });
    sock.deliver({ type: "reply.started", reply_id: "r2" });
    sock.deliver({ type: "tool.call", call_id: "b", name: "update_case_field", arguments: {} });
    sock.deliver({ type: "reply.done", reply_id: "r2", status: "interrupted" });
    resolvers.a!({ result: "accepted" });
    resolvers.b!({ result: "accepted" });
    await tick(5);
    expect(sock.sentOf("tool.result").map((r) => r.call_id)).toEqual(["a"]);
    expect(s.tools.traces.find((t) => t.call.call_id === "b")?.dropped).toBe("interrupted");
  });

  it("never answers server-side HTTP tools (learned from session config)", async () => {
    const { s, sock } = readySession();
    s.tools.policy = "immediate";
    sock.deliver({ type: "session.updated", config: { tools: [{ name: "lookup_policy", http: { url: "https://x" } }] } });
    sock.deliver({ type: "tool.call", call_id: "c9", name: "lookup_policy", arguments: {} });
    await tick(5);
    expect(sock.sentOf("tool.result")).toHaveLength(0);
    expect(s.tools.isServerSide("lookup_policy")).toBe(true);
    expect(s.tools.traces[0]?.dropped).toBe("server_side");
  });
});

describe("ReplyTracker", () => {
  it("measures the audible onset and classifies reply kinds", async () => {
    const { s, sock } = readySession();
    await s.start({ greeting: "Hi" });
    const done: ReplyInfo[] = [];
    s.replies.onReplyDone = (r) => done.push(r);
    // speech: 100 ms of silence, then audible audio
    sock.deliver({ type: "reply.started", reply_id: "r1" });
    sock.deliver({ type: "reply.audio", reply_id: "r1", data: bytesToBase64(pcm(0, 100)) });
    sock.deliver({ type: "reply.audio", reply_id: "r1", data: bytesToBase64(pcm(8000, 10)) });
    sock.deliver({ type: "transcript.agent.delta", reply_id: "r1", delta: "Hi", start_ms: 100, end_ms: 300 });
    sock.deliver({ type: "transcript.agent", reply_id: "r1", text: "Hi Priya." });
    sock.deliver({ type: "reply.done", reply_id: "r1", status: "completed" });
    // tool preamble: silent + a tool call
    sock.deliver({ type: "reply.started", reply_id: "r2" });
    sock.deliver({ type: "reply.audio", reply_id: "r2", data: bytesToBase64(pcm(0, 50)) });
    sock.deliver({ type: "tool.call", call_id: "c1", name: "get_disclosure", arguments: {} });
    sock.deliver({ type: "reply.done", reply_id: "r2", status: "completed" });
    // unspoken text
    sock.deliver({ type: "reply.started", reply_id: "r3" });
    sock.deliver({ type: "transcript.agent", reply_id: "r3", text: "never spoken" });
    sock.deliver({ type: "reply.done", reply_id: "r3", status: "completed" });
    // silent, no output (failing BYO LLM shape) -> E_VA_SILENT
    sock.deliver({ type: "reply.started", reply_id: "r4" });
    sock.deliver({ type: "reply.done", reply_id: "r4", status: "completed" });
    expect(done.map((r) => r.kind)).toEqual(["speech", "tool_preamble", "unspoken_text", "silent_no_output"]);
    expect(done[0]!.leadingSilenceMs).toBeCloseTo(100, 5);
    expect(done[0]!.audioMs).toBeCloseTo(110, 5);
    expect(done[0]!.firstAudibleAtMs).toBeDefined();
    expect(done[0]!.words).toEqual([{ text: "Hi", startMs: 100, endMs: 300 }]);
    expect(done[1]!.toolCalls).toEqual(["get_disclosure"]);
  });

  it("chunkLevelDb for PCM and mu-law", () => {
    expect(chunkLevelDb(pcm(0, 10))).toBe(-Infinity);
    expect(chunkLevelDb(pcm(16384, 10))).toBeGreaterThan(-12);
    const mu = mulawEncode(new Int16Array(80).fill(8000));
    expect(chunkLevelDb(mu, "audio/pcmu")).toBeCloseTo(20 * Math.log10(8000 / 32768), 0);
    expect(chunkLevelDb(new Uint8Array(80).fill(0xff), "audio/pcmu")).toBe(-Infinity);
  });
});

describe("RealtimeAudioFeeder", () => {
  it("sends 50 ms chunks at wall-clock pace, padding the last clip chunk with silence", async () => {
    const { s, sock } = readySession();
    await s.start({ greeting: "Hi" });
    const feeder = new RealtimeAudioFeeder(s);
    expect(feeder.chunkBytes).toBe(2400);
    feeder.start();
    const t0 = performance.now();
    const timing = await feeder.play(pcm(4000, 120));
    const elapsed = performance.now() - t0;
    await feeder.stop();
    expect(timing.chunks).toBe(3);
    expect(elapsed).toBeGreaterThanOrEqual(140);
    const audio = sock.sentOf("input.audio");
    expect(audio.length).toBeGreaterThanOrEqual(3);
    expect(audio.every((a) => atob(a.audio).length === 2400)).toBe(true);
  });
});

describe("helpers", () => {
  it("tokenUrl, errorCode, error mapping, voices", () => {
    expect(tokenUrl("abc")).toBe("wss://agents.assemblyai.com/v1/ws?token=abc");
    expect(errorCode({ error_code: "AT_CAPACITY" })).toBe("at_capacity");
    expect(errorCode({})).toBe("unknown");
    expect(vaErrorToErrorCode({ code: "unauthorized" })).toBe("E_VA_AUTH");
    expect(vaErrorToErrorCode({ code: "at_capacity" })).toBe("E_VA_CAPACITY");
    expect(vaErrorToErrorCode({ code: "server_error" })).toBe("E_VA_TRANSIENT");
    expect(vaErrorToErrorCode({ code: "immutable_field" })).toBe("E_VA_CONFIG");
    expect(vaErrorToErrorCode({ code: "whatever", message: "insufficient credit" })).toBe("E_AAI_BALANCE");
    expect(VA_VOICES).toHaveLength(18);
    expect(VA_VOICES).toContain("alba");
    expect(VA_VOICES).not.toContain("ivy");
  });
});
