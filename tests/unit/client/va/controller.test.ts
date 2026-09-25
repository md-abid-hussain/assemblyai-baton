import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LatencyHudImpl } from "../../../../src/client/hud/latency";
import { createVoiceAgentController, type VaControllerConfig } from "../../../../src/client/va/controller";
import { PAY_LINES } from "../../../../src/client/va/payment-watch";
import type { PaymentView, ToolResponse } from "../../../../src/core/contracts/api";
import type { VaControllerEvent } from "../../../../src/core/contracts/ext/wp5b-va";
import type { PageLifecycle } from "../../../../src/core/contracts/services";
import type { ToolName } from "../../../../src/core/contracts/tools";
import { FakeEngine, FakeSocket, RecordingSink, compiledFromFixture, pcmChunkB64 } from "./fakes";

const flush = async (n = 20) => {
  for (let i = 0; i < n; i++) await Promise.resolve();
};

type ToolImpl = (args: Record<string, unknown>) => ToolResponse | Promise<ToolResponse>;

function setup(o: { config?: Partial<VaControllerConfig>; tools?: Partial<Record<ToolName, ToolImpl>>; payment?: () => PaymentView; lifecycle?: PageLifecycle } = {}) {
  const engine = new FakeEngine();
  const sink = new RecordingSink();
  const ws = new FakeSocket();
  const hud = new LatencyHudImpl();
  const posts: unknown[] = [];
  const stageCalls: string[] = [];
  const toolCalls: { name: string; args: unknown }[] = [];
  const ctl = createVoiceAgentController({
    takeoverId: "to_1",
    repFirst: "Carmen",
    engine,
    sink,
    hud,
    openSocket: () => ws,
    callTool: async (name, args) => {
      toolCalls.push({ name, args });
      const impl = o.tools?.[name];
      if (!impl) return { result: { ok: true } };
      return impl(args as Record<string, unknown>);
    },
    pollPayment: async () => (o.payment ? o.payment() : payView("open")),
    stageSource: async (stage) => {
      stageCalls.push(stage);
      return { systemPrompt: `PROMPT ${stage}`, tools: compiledFromFixture().tools.slice(1) };
    },
    postEvents: async (b) => void posts.push(b),
    ...(o.lifecycle ? { lifecycle: o.lifecycle } : {}),
    config: o.config ?? {},
  });
  const events: VaControllerEvent[] = [];
  ctl.onEvent((e) => events.push(e));
  return { engine, sink, ws, hud, posts, ctl, events, toolCalls, stageCalls };
}

function payView(status: PaymentView["status"], toolResult?: PaymentView["toolResult"]): PaymentView {
  return { id: "pay_1", status, statusSource: status === "succeeded" ? "webhook" : null, amountCents: 2340, totalAmountCents: 2340, provider: "mock", simulated: false, embed: null, updatedAt: "x", ...(toolResult ? { toolResult } : {}) };
}

async function ready(s: ReturnType<typeof setup>, over = {}) {
  const p = s.ctl.connect("tok_abc");
  s.ws.open();
  await p;
  const sp = s.ctl.start(compiledFromFixture("first-update-confirm.json", over), { holdAudioUntilCtxMs: 4000 });
  s.ws.server({ type: "session.updated", config: {} });
  s.ws.server({ type: "session.ready", session_id: "sess_1", config: {} });
  return sp;
}

/** A spoken reply: started → n audible chunks (after `lead` silent chunks) → done. */
function speak(ws: FakeSocket, id: string, o: { lead?: number; chunks?: number; text?: string; done?: boolean } = {}) {
  ws.server({ type: "reply.started", reply_id: id });
  for (let i = 0; i < (o.lead ?? 2); i++) ws.server({ type: "reply.audio", reply_id: id, data: pcmChunkB64(0) });
  for (let i = 0; i < (o.chunks ?? 3); i++) ws.server({ type: "reply.audio", reply_id: id, data: pcmChunkB64(8000) });
  if (o.text) ws.server({ type: "transcript.agent", reply_id: id, text: o.text });
  if (o.done !== false) ws.server({ type: "reply.done", reply_id: id, status: "completed" });
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("VoiceAgentController: connect and first update (§5.9.1)", () => {
  it("sends exactly one validated first update, starts the feeder only after session.ready, marks the HUD", async () => {
    const s = setup();
    const p = s.ctl.connect("tok_abc");
    s.ws.open();
    await p;
    const sp = s.ctl.start(compiledFromFixture(), { holdAudioUntilCtxMs: 4000 });
    expect(s.ws.types()).toEqual(["session.update"]);
    expect(s.engine.feeders).toHaveLength(0); // nothing before session.ready
    expect(s.engine.player.holdUntilMs).toBe(4000);
    const upd = s.ws.control[0] as { session: { input: Record<string, unknown>; tools: { execution_mode: string }[] } };
    expect(upd.session.input.keyterms).toEqual(["Lucas Delgado", "Corolla"]); // VA_KEYTERMS=1 default (T-D1-0)
    expect(upd.session.tools.every((t) => t.execution_mode === "interactive")).toBe(true);
    s.ws.server({ type: "session.updated", config: {} });
    s.ws.server({ type: "session.ready", session_id: "sess_1", config: {} });
    await expect(sp).resolves.toEqual({ sessionId: "sess_1" });
    expect(s.engine.feeder.started).toBe(1);
    expect(s.ctl.phase).toBe("ready");
    expect(s.hud.snapshot().marks.map((m) => m.name)).toEqual(["updateSent", "sessionReady"]);
    expect(s.hud.snapshot().sessionIds.va).toBe("sess_1");
    expect(s.sink.of("va.status").map((e) => e.status)).toEqual(["connecting", "ready"]);
    await flush();
    expect(s.posts).toContainEqual({ vaSessionId: "sess_1" });
    expect(s.events[0]).toMatchObject({ type: "ready", sessionId: "sess_1" });
  });

  it("an invalid compiled config throws E_VA_CONFIG before a byte is sent", async () => {
    const s = setup();
    const p = s.ctl.connect("tok");
    s.ws.open();
    await p;
    const bad = compiledFromFixture();
    bad.tools[0]!.execution_mode = "hold";
    await expect(s.ctl.start(bad, { holdAudioUntilCtxMs: 0 })).rejects.toMatchObject({ code: "E_VA_CONFIG" });
    expect(s.ws.sent).toEqual([]);
    expect(s.events.at(-1)).toMatchObject({ type: "error", code: "E_VA_CONFIG", retryable: false });
  });

  it("a fatal first-update error is E_VA_CONFIG (no retry); unauthorized is E_VA_AUTH (retry with a new token)", async () => {
    for (const [code, want, retryable] of [["invalid_value", "E_VA_CONFIG", false], ["unauthorized", "E_VA_AUTH", true]] as const) {
      const s = setup();
      const p = s.ctl.connect("tok");
      s.ws.open();
      await p;
      const sp = s.ctl.start(compiledFromFixture(), { holdAudioUntilCtxMs: 0 });
      s.ws.server({ type: "session.error", code, message: "x" });
      s.ws.serverClose(1008);
      await expect(sp).rejects.toMatchObject({ code: want });
      expect(s.events.find((e) => e.type === "error")).toMatchObject({ code: want, retryable, afterFirstUpdate: true });
    }
  });

  it("socket open timeout → E_VA_TRANSIENT", async () => {
    const s = setup();
    const p = s.ctl.connect("tok");
    const assertion = expect(p).rejects.toMatchObject({ code: "E_VA_TRANSIENT" });
    await vi.advanceTimersByTimeAsync(3001);
    await assertion;
  });
});

describe("VoiceAgentController: audio out, captions, barge-in (§5.9.3, §5.10)", () => {
  it("trims leading silence, reports first audible PLAYED (held until the rep line ends) and captions after it", async () => {
    const s = setup();
    await ready(s);
    s.engine.clock.t = 1000;
    s.ws.server({ type: "reply.started", reply_id: "g" });
    s.ws.server({ type: "reply.audio", reply_id: "g", data: pcmChunkB64(0) });
    s.ws.server({ type: "reply.audio", reply_id: "g", data: pcmChunkB64(3) }); // ≈-80 dBFS: still silent
    s.ws.server({ type: "transcript.agent.delta", reply_id: "g", delta: "Hi", start_ms: 30 });
    expect(s.engine.player.pushes).toEqual([]);
    expect(s.sink.of("va.caption")).toEqual([]);
    s.ws.server({ type: "reply.audio", reply_id: "g", data: pcmChunkB64(8000) });
    expect(s.engine.player.pushes).toEqual([{ replyId: "g", audible: true, bytes: 480 }]);
    // FakePlayer plays at max(now, holdUntil=4000)
    expect(s.events.find((e) => e.type === "first_audible")).toMatchObject({ replyId: "g", ctxMs: 4000, greeting: true });
    expect(s.sink.of("va.caption")[0]?.words).toEqual([{ text: "Hi", atMs: 4010 }]); // 4000 + (30 − 20 ms trimmed)
    expect(s.ctl.phase).toBe("active");
  });

  it("barge-in flushes playback immediately, truncates captions and drops the rest of the reply", async () => {
    const s = setup();
    await ready(s);
    s.engine.clock.t = 10_000;
    speak(s.ws, "r1", { chunks: 200, done: false }); // 2 s of audio buffered, playing from 10 000
    for (const [w, st] of [["Your", 0], ["order", 400], ["is", 900], ["ready", 1500]] as const) s.ws.server({ type: "transcript.agent.delta", reply_id: "r1", delta: w, start_ms: st + 20 });
    s.engine.clock.t = 10_600;
    const before = s.engine.player.flushes;
    s.ws.server({ type: "input.speech.started" });
    expect(s.engine.player.flushes).toBe(before + 1);
    const cap = s.sink.of("va.caption").at(-1)!;
    expect(cap.words.map((w) => w.text)).toEqual(["Your", "order", "—"]);
    expect(s.sink.of("va.reply").at(-1)).toMatchObject({ replyId: "r1", phase: "done", interrupted: true });
    const pushed = s.engine.player.pushes.length;
    s.ws.server({ type: "reply.audio", reply_id: "r1", data: pcmChunkB64(8000) });
    s.ws.server({ type: "reply.done", reply_id: "r1", status: "interrupted" });
    s.ws.server({ type: "transcript.agent", reply_id: "r1", text: "Your order", interrupted: true });
    expect(s.engine.player.pushes.length).toBe(pushed);
    expect(s.sink.of("va.reply").filter((e) => e.interrupted)).toHaveLength(1); // first signal wins
  });

  it("input.speech.started with no agent audio playing is not a barge-in", async () => {
    const s = setup();
    await ready(s);
    const before = s.engine.player.flushes;
    s.ws.server({ type: "input.speech.started" });
    expect(s.engine.player.flushes).toBe(before);
    expect(s.sink.of("va.caption")).toEqual([]);
  });

  it("E_VA_SILENT: once → 'Please continue.', twice → retryable error", async () => {
    const s = setup();
    await ready(s);
    const silent = (id: string) => {
      s.ws.server({ type: "reply.started", reply_id: id });
      s.ws.server({ type: "reply.audio", reply_id: id, data: pcmChunkB64(0) });
      s.ws.server({ type: "reply.done", reply_id: id, status: "completed" });
    };
    silent("s1");
    expect(s.ws.control.at(-1)).toEqual({ type: "reply.create", instructions: "Please continue." });
    silent("s2");
    expect(s.events.at(-1)).toMatchObject({ type: "error", code: "E_VA_SILENT", retryable: true });
  });
});

describe("VoiceAgentController: tools and stages (§5.9.4, T-D1-2/T-D1-4)", () => {
  it("stage change: session.update{system_prompt, tools, input} goes out BEFORE tool.result", async () => {
    const s = setup({
      tools: {
        confirm_effective_date: () => ({
          result: { accepted: true, effective_date: "2026-09-26", spoken: "Saturday, September 26th", next: "disclose" },
          stage: "disclose",
          systemPrompt: "PROMPT disclose",
          tools: compiledFromFixture("first-update-disclose.json").tools,
          transcriptionMode: "balanced",
        }),
      },
    });
    await ready(s);
    s.ws.server({ type: "reply.started", reply_id: "pre" });
    s.ws.server({ type: "tool.call", call_id: "c1", name: "confirm_effective_date", arguments: { date: "2026-09-26", customer_words: "yes" } });
    await flush();
    const tail = s.ws.control.slice(-2);
    expect(tail.map((m) => m.type)).toEqual(["session.update", "tool.result"]);
    const upd = tail[0] as { session: { system_prompt: string; tools: { name: string }[]; input: unknown } };
    expect(upd.session.system_prompt).toBe("PROMPT disclose");
    expect(upd.session.tools.map((t) => t.name)).toEqual(["get_disclosure", "confirm_effective_date", "update_case_field", "hand_back_to_rep"]);
    expect(upd.session.input).toEqual({ transcription_mode: "balanced" });
    expect(JSON.parse((tail[1] as { result: string }).result)).toMatchObject({ accepted: true, next: "disclose" });
    expect(s.ctl.stage).toBe("disclose");
    expect(s.sink.of("stage")).toEqual([expect.objectContaining({ stage: "disclose" })]);
    expect(s.sink.of("va.tool").map((e) => e.phase)).toEqual(["call", "result"]);
  });

  it("inputModeMutable=false never changes the transcription mode", async () => {
    const s = setup({ config: { inputModeMutable: false }, tools: { update_case_field: () => ({ result: { result: "accepted" }, transcriptionMode: "balanced" }) } });
    await ready(s);
    s.ws.server({ type: "tool.call", call_id: "c1", name: "update_case_field", arguments: {} });
    await flush();
    expect(s.ws.types().slice(-1)).toEqual(["tool.result"]);
  });

  it("an invented tool name is answered with is_error by the dispatcher and logged as E_VA_CONFIG", async () => {
    const s = setup();
    await ready(s);
    s.ws.server({ type: "tool.call", call_id: "cx", name: "lookup_weather", arguments: {} });
    await flush();
    expect(s.sink.of("error")).toContainEqual(expect.objectContaining({ code: "E_VA_CONFIG", message: "unknown tool lookup_weather" }));
    expect(s.ws.control.at(-1)).toMatchObject({ type: "tool.result", call_id: "cx", is_error: true });
  });

  it("mid-session config errors are logged and the session continues", async () => {
    const s = setup();
    await ready(s);
    s.ws.server({ type: "session.error", code: "immutable_field", message: "'greeting' cannot be changed", param: "greeting" });
    expect(s.sink.of("error").at(-1)).toMatchObject({ code: "E_VA_CONFIG" });
    expect(s.events.some((e) => e.type === "error")).toBe(false);
  });

  it("hand_back_to_rep: result sent, then `hand_back` after the agent's sentence has played", async () => {
    const s = setup({ tools: { hand_back_to_rep: () => ({ result: { status: "transferring", message: "Tell the customer Carmen is coming back on the line now." } }) } });
    await ready(s);
    s.ws.server({ type: "tool.call", call_id: "hb", name: "hand_back_to_rep", arguments: { reason: "advice_requested", summary: "Asked about deductibles." } });
    await flush();
    expect(s.ws.control.at(-1)).toMatchObject({ type: "tool.result", call_id: "hb" });
    s.engine.clock.t = 20_000;
    speak(s.ws, "bye", { chunks: 100, text: "Carmen is coming back on the line now." }); // 1 s of audio
    expect(s.events.some((e) => e.type === "hand_back")).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.events.find((e) => e.type === "hand_back")).toEqual({ type: "hand_back", reason: "advice_requested", summary: "Asked about deductibles." });
  });

  it("close_ready after send_confirmation: not after a question, yes after the goodbye + 2.5 s quiet", async () => {
    const s = setup({ tools: { send_confirmation: () => ({ result: { ok: true, confirmation_number: "END-48213", spoken: "E N D 4 8 2 1 3", sms_sent: true } }) } });
    await ready(s);
    s.engine.clock.t = 10_000;
    s.ws.server({ type: "tool.call", call_id: "sc", name: "send_confirmation", arguments: {} });
    await flush();
    speak(s.ws, "read", { chunks: 1, text: "Your confirmation number is E N D 4 8 2 1 3. Anything else?" });
    await vi.advanceTimersByTimeAsync(3000);
    expect(s.events.some((e) => e.type === "close_ready")).toBe(false);
    s.ws.server({ type: "input.speech.started" });
    s.ws.server({ type: "input.speech.stopped" });
    speak(s.ws, "bye", { chunks: 1, text: "You're welcome. Goodbye!" });
    await vi.advanceTimersByTimeAsync(2600);
    expect(s.events.some((e) => e.type === "close_ready")).toBe(true);
  });
});

describe("VoiceAgentController: pay step (§5.8, PAY_TOOL_MODE)", () => {
  const payTool: ToolImpl = () => ({ result: { status: "link_sent" }, ui: { sms: "Mesa Ridge: sign and pay here", link: "https://x/pay/1", paymentId: "pay_1" } });

  it("push (default): link_sent answered at once, paying pauses the cap, success → close stage then 'call send_confirmation'", async () => {
    let status: PaymentView["status"] = "open";
    const s = setup({
      tools: { send_esign_and_pay_link: payTool },
      payment: () => (status === "succeeded" ? payView("succeeded", { status: "paid", amount: "$23.40", receipt: "PAY-1", verified_by: "polar_webhook" }) : payView(status)),
    });
    await ready(s);
    s.ws.server({ type: "tool.call", call_id: "p1", name: "send_esign_and_pay_link", arguments: { customer_agreed_to_text: true, paper_copy_requested: false, customer_words: "yes" } });
    await flush();
    expect(s.ws.control.at(-1)).toMatchObject({ type: "tool.result", call_id: "p1" });
    expect(JSON.parse((s.ws.control.at(-1) as { result: string }).result)).toEqual({ status: "link_sent" });
    expect(s.sink.of("phone.sms")).toEqual([expect.objectContaining({ text: "Mesa Ridge: sign and pay here", link: "https://x/pay/1" })]);
    expect(s.ctl.phase).toBe("paying");
    expect(s.events).toContainEqual({ type: "paying", on: true });
    status = "succeeded";
    await vi.advanceTimersByTimeAsync(1600);
    await flush();
    expect(s.stageCalls).toEqual(["close"]);
    const tail = s.ws.control.slice(-2);
    expect(tail[0]).toMatchObject({ type: "session.update", session: { system_prompt: "PROMPT close" } });
    expect(tail[1]).toEqual({ type: "reply.create", instructions: PAY_LINES.paid });
    expect(s.ctl.stage).toBe("close");
    expect(s.ctl.phase).toBe("active");
    expect(s.sink.of("payment").at(-1)).toMatchObject({ status: "succeeded", source: "webhook" });
  });

  it("hold: the result is withheld; on success the close update goes out BEFORE the server-built tool.result", async () => {
    let status: PaymentView["status"] = "open";
    const s = setup({
      config: { payToolMode: "hold" },
      tools: { send_esign_and_pay_link: payTool },
      payment: () => (status === "succeeded" ? payView("succeeded", { status: "paid", amount: "$23.40", receipt: "PAY-1", verified_by: "simulated" }) : payView(status)),
    });
    await ready(s);
    s.ws.server({ type: "reply.started", reply_id: "pre" });
    s.ws.server({ type: "tool.call", call_id: "p1", name: "send_esign_and_pay_link", arguments: {} });
    await flush();
    expect(s.ws.control.at(-1)).toEqual({ type: "reply.create", instructions: PAY_LINES.status });
    // T-D1-1: a silent reply during the hold is not E_VA_SILENT
    s.ws.server({ type: "reply.done", reply_id: "pre", status: "completed" });
    s.ws.server({ type: "reply.started", reply_id: "st" });
    s.ws.server({ type: "reply.done", reply_id: "st", status: "completed" });
    expect(s.ws.control.some((m) => m.instructions === "Please continue.")).toBe(false);
    status = "succeeded";
    await vi.advanceTimersByTimeAsync(1600);
    await flush();
    const tail = s.ws.control.slice(-2);
    expect(tail.map((m) => m.type)).toEqual(["session.update", "tool.result"]);
    expect(JSON.parse((tail[1] as { result: string }).result)).toEqual({ status: "paid", amount: "$23.40", receipt: "PAY-1", verified_by: "simulated" });
  });

  it("not_sent (no consent) is answered as a plain interactive result, no paying", async () => {
    const s = setup({ tools: { send_esign_and_pay_link: () => ({ result: { status: "not_sent", reason: "consent_required" } }) } });
    await ready(s);
    s.ws.server({ type: "tool.call", call_id: "p1", name: "send_esign_and_pay_link", arguments: {} });
    await flush();
    expect(JSON.parse((s.ws.control.at(-1) as { result: string }).result)).toEqual({ status: "not_sent", reason: "consent_required" });
    expect(s.ctl.phase).toBe("ready");
  });

  it("timeout at 60 s (phone untouched) → timeout line + payment event; a late success still closes", async () => {
    let status: PaymentView["status"] = "open";
    const s = setup({
      tools: { send_esign_and_pay_link: payTool },
      payment: () => (status === "succeeded" ? payView("succeeded", { status: "paid", amount: "$23.40", receipt: "PAY-1", verified_by: "polar_webhook" }) : payView(status)),
    });
    await ready(s);
    s.ctl.setPayingState("sms-received");
    s.ws.server({ type: "tool.call", call_id: "p1", name: "send_esign_and_pay_link", arguments: {} });
    await flush();
    s.engine.clock.t = 45_000;
    await vi.advanceTimersByTimeAsync(300);
    expect(s.ws.control.at(-1)).toEqual({ type: "reply.create", instructions: PAY_LINES.reassure });
    s.engine.clock.t = 60_000;
    await vi.advanceTimersByTimeAsync(300);
    expect(s.ws.control.at(-1)).toEqual({ type: "reply.create", instructions: PAY_LINES.timeout });
    expect(s.sink.of("payment").at(-1)).toMatchObject({ status: "timeout" });
    expect(s.ctl.phase).toBe("active");
    status = "succeeded";
    await vi.advanceTimersByTimeAsync(3500);
    await flush();
    expect(s.ws.control.at(-1)).toEqual({ type: "reply.create", instructions: PAY_LINES.latePaid });
  });
});

describe("VoiceAgentController: cap, heartbeats, lifecycle, ending (§5.9.5)", () => {
  it("heartbeats every 10 s; wrap-up at cap − 20 s but never while paying", async () => {
    const s = setup({ tools: { send_esign_and_pay_link: () => ({ result: { status: "link_sent" }, ui: { paymentId: "pay_1" } }) } });
    await ready(s, { vaSessionCapMs: 30_000 });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(s.posts.filter((p) => (p as { heartbeat?: boolean }).heartbeat)).toHaveLength(1);
    s.ws.server({ type: "tool.call", call_id: "p1", name: "send_esign_and_pay_link", arguments: {} });
    await flush();
    s.engine.clock.t = 25_000;
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.events.some((e) => e.type === "wrap_up")).toBe(false); // paying
  });

  it("wrap-up never fires once closing (after close_ready)", async () => {
    const s = setup({ tools: { send_confirmation: () => ({ result: { ok: true, confirmation_number: "END-1", spoken: "E N D 1", sms_sent: true } }) } });
    await ready(s, { vaSessionCapMs: 60_000 });
    s.engine.clock.t = 10_000;
    s.ws.server({ type: "tool.call", call_id: "sc", name: "send_confirmation", arguments: {} });
    await flush();
    speak(s.ws, "bye", { chunks: 1, text: "Goodbye!" });
    await vi.advanceTimersByTimeAsync(2600);
    expect(s.events.some((e) => e.type === "close_ready")).toBe(true);
    s.engine.clock.t = 45_000; // past cap − 20 s
    await vi.advanceTimersByTimeAsync(2000);
    expect(s.events.some((e) => e.type === "wrap_up")).toBe(false);
  });

  it("wrap-up then end at the cap", async () => {
    const s = setup();
    await ready(s, { vaSessionCapMs: 30_000 });
    s.engine.clock.t = 10_000;
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.events.find((e) => e.type === "wrap_up")).toBeTruthy();
    expect(s.ws.control.at(-1)).toEqual({ type: "reply.create", instructions: "Tell the customer you need to wrap up and that Carmen will follow up on anything left." });
    s.engine.clock.t = 30_000;
    await vi.advanceTimersByTimeAsync(1000);
    await flush();
    expect(s.ws.types()).toContain("session.end");
    expect(s.events.at(-1)).toMatchObject({ type: "ended", reason: "cap" });
  });

  it("iOS hidden for 10 s → session.end; a resume before that cancels", async () => {
    const pause = new Set<(r: "ios_background" | "audio_interrupted") => void>();
    const resume = new Set<() => void>();
    const lifecycle: PageLifecycle = {
      isIOS: true,
      onPause: (cb) => (pause.add(cb), () => pause.delete(cb)),
      onResume: (cb) => (resume.add(cb), () => resume.delete(cb)),
    };
    const s = setup({ lifecycle });
    await ready(s);
    for (const cb of pause) cb("ios_background");
    await vi.advanceTimersByTimeAsync(5000);
    for (const cb of resume) cb();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(s.ws.types()).not.toContain("session.end");
    for (const cb of pause) cb("ios_background");
    await vi.advanceTimersByTimeAsync(10_000);
    await flush();
    expect(s.ws.types()).toContain("session.end");
    expect(s.events.at(-1)).toMatchObject({ type: "ended", reason: "ios_background" });
  });

  it("end(): session.end → session.ended → close; ended event with the billed seconds", async () => {
    const s = setup();
    await ready(s);
    await s.ctl.end("done");
    expect(s.ws.types().at(-1)).toBe("session.end");
    expect(s.ws.closeCalls.length).toBeGreaterThan(0);
    expect(s.events.at(-1)).toEqual({ type: "ended", reason: "done", sessionSeconds: 12.5, sessionId: "sess_1" });
    expect(s.ctl.phase).toBe("ended");
    await s.ctl.end("again"); // idempotent
    expect(s.events.filter((e) => e.type === "ended")).toHaveLength(1);
  });

  it("an unexpected close after ready is a retryable error, then ended", async () => {
    const s = setup();
    await ready(s);
    s.ws.serverClose(1011, "server error");
    expect(s.events.find((e) => e.type === "error")).toMatchObject({ code: "E_VA_TRANSIENT", retryable: true });
    expect(s.events.at(-1)).toMatchObject({ type: "ended", reason: "closed_1011" });
    expect(s.ctl.phase).toBe("failed");
  });

  it("customer clips mark the HUD eos at the clip end; the slow-network badge follows bufferedAmount", async () => {
    const s = setup();
    await ready(s);
    s.engine.clock.t = 7000;
    const r = await s.ctl.playCustomerClip(new Int16Array(24_000));
    expect(r.endCtxMs).toBe(8000);
    expect(s.hud.snapshot().marks.at(-1)).toEqual({ name: "eos", ctxMs: 8000 });
    s.ws.bufferedAmount = 70_000;
    s.engine.feeder.tick();
    expect(s.hud.snapshot().slowNetwork).toBe(true);
    s.ws.bufferedAmount = 0;
    s.engine.feeder.tick();
    expect(s.hud.snapshot().slowNetwork).toBe(false);
  });
});
