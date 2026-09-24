/**
 * src/core/aai/streaming.ts: port of spikes/streaming/selftest.ts (buildStreamingUrl, FrameBatcher x2, TurnTracker,
 * sanitizeParams) plus session behaviour against an in-memory fake socket (no network, no AssemblyAI session).
 */
import { describe, expect, it } from "vitest";
import {
  FrameBatcher, LIMITS, StreamingConnectError, StreamingSession, TurnTracker, buildStreamingUrl, defaultWebSocketFactory,
  isRetryableClose, looksLikeBalanceError, sanitizeParams, sttCloseToErrorCode,
  type ConnectOptions, type TurnMessage, type WebSocketLike,
} from "../../../../src/core/aai/streaming";

// ------------------------------------------------------------------------------------------ fake socket

class FakeStreamingSocket implements WebSocketLike {
  readyState = 0;
  binaryType = "blob";
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  readonly sent: (string | number)[] = [];
  readonly url: string;
  readonly headers: Record<string, string> | undefined;
  constructor(url: string, headers: Record<string, string> | undefined, script: "ok" | "error3006" | "inactivity") {
    this.url = url;
    this.headers = headers;
    setTimeout(() => {
      this.readyState = 1;
      this.onopen?.({});
      if (script === "ok") this.deliver({ type: "Begin", id: "sess-abc", expires_at: 1_790_000_000, configuration: { speech_model: "universal-3-5-pro", mode: "min_latency" } });
      else {
        const error = script === "inactivity" ? "Session terminated due to inactivity" : "Invalid sample_rate";
        this.deliver({ error_code: 3006, error });
        setTimeout(() => this.serverClose(3006, "See Error message for details"), 5);
      }
    }, 1);
  }
  deliver(msg: unknown, asBytes = false): void {
    const text = JSON.stringify(msg);
    this.onmessage?.({ data: asBytes ? new TextEncoder().encode(text).buffer : text });
  }
  serverClose(code: number, reason: string): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
  send(data: string | ArrayBufferLike | ArrayBufferView): void {
    if (typeof data === "string") {
      this.sent.push(data);
      if ((JSON.parse(data) as { type: string }).type === "Terminate") {
        setTimeout(() => {
          this.deliver({ type: "Termination", audio_duration_seconds: 1, session_duration_seconds: 2 });
          this.serverClose(1000, "");
        }, 2);
      }
    } else this.sent.push((data as ArrayBufferView | ArrayBuffer).byteLength);
  }
  close(code = 1000, reason = ""): void {
    this.serverClose(code, reason);
  }
}

const sockets: FakeStreamingSocket[] = [];
const factory =
  (script: "ok" | "error3006" | "inactivity" = "ok"): ConnectOptions["factory"] =>
  (url, headers) => {
    const s = new FakeStreamingSocket(url, headers, script);
    sockets.push(s);
    return s;
  };
/**
 * Opens against the in-memory fake only (the factory is injected), never a live AssemblyAI session. This file is on
 * the boundaries test's FAKE_SOCKET_TESTS allow-list, which also proves it cannot reach a credential or real socket.
 */
const openFake = (o: Omit<ConnectOptions, "factory">, script?: "ok" | "error3006" | "inactivity") =>
  StreamingSession.connect({ ...o, factory: factory(script) });

// ------------------------------------------------------------------------------------------ spike selftest port

describe("streaming helpers (spike selftest port)", () => {
  it("buildStreamingUrl JSON-encodes arrays/objects, skips undefined", () => {
    const u = new URL(
      buildStreamingUrl(
        { speech_model: "universal-3-5-pro", sample_rate: 16000, keyterms_prompt: ["A B", "C"], speaker_labels: true, prompt: undefined, llm_gateway: { model: "m", messages: [{ role: "user", content: "{{turn}}" }], max_tokens: 5 } },
        { token: "t" },
      ),
    );
    expect(u.origin + u.pathname).toBe("wss://streaming.assemblyai.com/v3/ws");
    expect(u.searchParams.get("keyterms_prompt")).toBe('["A B","C"]');
    expect(u.searchParams.get("speaker_labels")).toBe("true");
    expect(u.searchParams.get("prompt")).toBeNull();
    expect((JSON.parse(u.searchParams.get("llm_gateway")!) as { messages: { content: string }[] }).messages[0]!.content).toBe("{{turn}}");
    expect(u.searchParams.get("token")).toBe("t");
  });

  it("FrameBatcher: 128-sample worklet quanta -> exact 50 ms frames", () => {
    const b = new FrameBatcher({ sampleRate: 16000 });
    let out: Uint8Array[] = [];
    for (let i = 0; i < 20; i++) out = out.concat(b.push(new Uint8Array(256).fill(i + 1)));
    expect(b.frameBytes).toBe(1600);
    expect(out).toHaveLength(3);
    expect(out.every((f) => f.byteLength === 1600)).toBe(true);
    expect(out[1]![0]).toBe(7);
    expect(b.pendingBytes).toBe(320);
    const tail = b.flush()!;
    expect(tail.byteLength).toBe(1600);
    expect(tail[319]).toBe(20);
    expect(tail[320]).toBe(0);
    expect(b.flush()).toBeNull();
  });

  it("FrameBatcher: Twilio 20 ms mu-law frames -> 100 ms frames, pad with 0xFF", () => {
    const b = new FrameBatcher({ sampleRate: 8000, bytesPerSample: 1, targetMs: 100 });
    let out: Uint8Array[] = [];
    for (let i = 0; i < 12; i++) out = out.concat(b.push(new Uint8Array(160).fill(0x10)));
    expect(out).toHaveLength(2);
    expect(out[0]!.byteLength).toBe(800);
    const tail = b.flush()!;
    expect(tail.byteLength).toBe(400);
    expect(tail[399]).toBe(0xff);
    expect(() => new FrameBatcher({ sampleRate: 8000, targetMs: 20 })).toThrow(RangeError);
  });

  it("TurnTracker: replace not append; format_turns double final; open partials", () => {
    const t = new TurnTracker({ waitForFormatted: true });
    const base = { type: "Turn" as const, turn_order: 0, end_of_turn_confidence: 0, words: [] };
    expect(t.apply({ ...base, transcript: "hi", end_of_turn: false, turn_is_formatted: false } as TurnMessage)).toBe("partial");
    expect(t.hasOpenPartial()).toBe(true);
    expect(t.apply({ ...base, transcript: "hi there", end_of_turn: true, turn_is_formatted: false } as TurnMessage)).toBe("partial");
    expect(t.apply({ ...base, transcript: "Hi there.", end_of_turn: true, turn_is_formatted: true } as TurnMessage)).toBe("final");
    expect(t.hasOpenPartial()).toBe(false);
    expect(t.text()).toEqual(["Hi there."]);
    t.applyRevision({ type: "SpeakerRevision", revisions: [{ turn_order: 0, speaker_label: "B", words: [] }] });
    expect(t.text()).toEqual(["B: Hi there."]);
    expect(t.apply({ ...base, transcript: "Hi there.", end_of_turn: true, turn_is_formatted: true } as TurnMessage)).toBe("duplicate-final");
    expect(t.apply({ ...base, turn_order: 1, transcript: "", end_of_turn: true, turn_is_formatted: true } as TurnMessage)).toBe("empty-final");
  });

  it("sanitizeParams clips to server limits", () => {
    const p = sanitizeParams({ agent_context: "a".repeat(10) + "z".repeat(1750), prompt: "p".repeat(2000), keyterms_prompt: [...Array.from({ length: 105 }, (_, i) => `k${i}`), "x".repeat(51)] });
    expect(p.agent_context!.length).toBe(LIMITS.agentContextChars);
    expect(p.agent_context!.startsWith("z")).toBe(true);
    expect(p.prompt!.length).toBe(LIMITS.promptChars);
    expect(p.keyterms_prompt).toHaveLength(100);
  });
});

describe("error mapping (DESIGN §5.1.9, §7.4)", () => {
  it("maps closes to error codes", () => {
    expect(sttCloseToErrorCode(1000)).toBeNull();
    expect(sttCloseToErrorCode(1006)).toBe("E_STT_TRANSIENT");
    expect(sttCloseToErrorCode(1011)).toBe("E_STT_TRANSIENT");
    expect(sttCloseToErrorCode(3005)).toBe("E_STT_TRANSIENT");
    expect(sttCloseToErrorCode(1008, "Too many concurrent sessions")).toBe("E_STT_RATE");
    expect(sttCloseToErrorCode(3009)).toBe("E_STT_RATE");
    expect(sttCloseToErrorCode(1008, "Invalid API key")).toBe("E_STT_AUTH");
    expect(sttCloseToErrorCode(3006, "Session terminated due to inactivity")).toBe("E_STT_INACTIVITY");
    expect(sttCloseToErrorCode(3006, "Invalid JSON")).toBe("E_STT_INPUT");
    expect(sttCloseToErrorCode(3007)).toBe("E_STT_INPUT");
    expect(sttCloseToErrorCode(1008, "Insufficient account balance")).toBe("E_AAI_BALANCE");
    expect(isRetryableClose(1006) && !isRetryableClose(1008) && !isRetryableClose(3007)).toBe(true);
    expect(looksLikeBalanceError("Your credit is exhausted")).toBe(true);
    expect(looksLikeBalanceError("Invalid sample rate")).toBe(false);
  });
});

describe("StreamingSession against a fake socket", () => {
  it("connects on Begin, sends validated binary frames and JSON control, terminates cleanly", async () => {
    const s = await openFake({ auth: { token: "tok-1" }, params: { speech_model: "universal-3-5-pro", sample_rate: 16000, encoding: "pcm_s16le", mode: "min_latency", agent_context: "x".repeat(2000) } });
    const sock = sockets.at(-1)!;
    expect(sock.headers).toBeUndefined();
    const url = new URL(sock.url);
    expect(url.searchParams.get("token")).toBe("tok-1");
    expect(url.searchParams.get("agent_context")!.length).toBe(1750); // sanitized before connect
    expect(s.sessionId).toBe("sess-abc");
    expect(s.isOpen).toBe(true);

    const turns: TurnMessage[] = [];
    s.on("turn", (t) => turns.push(t));
    sock.deliver({ type: "Turn", turn_order: 0, turn_is_formatted: true, end_of_turn: false, transcript: "Hello", end_of_turn_confidence: 0.1, words: [] });
    sock.deliver({ type: "Turn", turn_order: 0, turn_is_formatted: true, end_of_turn: true, transcript: "Hello there.", end_of_turn_confidence: 0.9, words: [] }, true);
    expect(turns.map((t) => t.transcript)).toEqual(["Hello", "Hello there."]);

    expect(s.sendAudio(new Uint8Array(1600))).toBe(true);
    expect(() => s.sendAudio(new Uint8Array(640))).toThrow(RangeError); // 20 ms -> 3007 on the server
    expect(s.updateConfiguration({ agent_context: "y".repeat(1800) })).toBe(true);
    expect(s.forceEndpoint()).toBe(true);
    const upd = JSON.parse(sock.sent.find((x) => typeof x === "string" && x.includes("UpdateConfiguration")) as string) as { agent_context: string };
    expect(upd.agent_context).toHaveLength(1750);

    const term = await s.terminate({ timeoutMs: 1000 });
    expect(term?.session_duration_seconds).toBe(2);
    expect((await s.closed).code).toBe(1000);
    expect(s.sendAudio(new Uint8Array(1600))).toBe(false);
    expect(sock.sent.filter((x) => typeof x === "number")).toEqual([1600]);
  });

  it("passes the API key as a header (Node) and rejects with the server error before Begin", async () => {
    const err = await openFake({ auth: { apiKey: "raw-key" }, params: { sample_rate: 16000 } }, "error3006").catch((e: unknown) => e);
    expect(sockets.at(-1)!.headers).toEqual({ Authorization: "raw-key" });
    expect(err).toBeInstanceOf(StreamingConnectError);
    const ce = err as StreamingConnectError;
    expect(ce.details.closeCode).toBe(3006);
    expect(ce.details.serverError?.error).toMatch(/sample_rate/);
    expect(ce.errorCode).toBe("E_STT_INPUT");
  });

  it("classifies an inactivity close as E_STT_INACTIVITY", async () => {
    const err = (await openFake({ auth: { token: "t" }, params: {} }, "inactivity").catch((e: unknown) => e)) as StreamingConnectError;
    expect(err.errorCode).toBe("E_STT_INACTIVITY");
  });

  it("the default factory lazy-loads `ws` only when headers are needed (loopback, no AssemblyAI)", async () => {
    const sock = await defaultWebSocketFactory("ws://127.0.0.1:9/", { Authorization: "x" });
    sock.onerror = () => undefined;
    expect(typeof (sock as unknown as { on?: unknown }).on).toBe("function"); // the Node `ws` implementation
    await new Promise<void>((resolve) => {
      sock.onclose = () => resolve();
      try {
        sock.close();
      } catch {
        resolve();
      }
    });
  });
});
