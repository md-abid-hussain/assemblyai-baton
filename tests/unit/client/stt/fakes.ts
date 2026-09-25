/**
 * Fakes for the STT channel manager: an in-memory session (no socket, no network, no credentials) and a scripted
 * route-#5/#7 API. They satisfy `SttSessionLike` / `SttApi` structurally.
 */
import type { BeginMessage, ErrorMessage, StreamingParams, TerminationMessage, TurnMessage, UpdateConfigurationPatch } from "../../../../src/core/aai/streaming";
import type { SessionReport, SttTokenRequest, SttTokenResponse } from "../../../../src/core/contracts/api";
import type { Channel } from "../../../../src/core/contracts/case";
import type { BatonEvent } from "../../../../src/core/contracts/events";
import type { SttApi } from "../../../../src/client/stt/api";
import type { SttConnect, SttSessionLike } from "../../../../src/client/stt/channel-manager";

type Listener = (ev: never) => void;

export class FakeSession implements SttSessionLike {
  begin: BeginMessage;
  lastError: ErrorMessage | null = null;
  termination: TerminationMessage | null = null;
  isOpen = true;
  readonly frames: Uint8Array[] = [];
  readonly updates: UpdateConfigurationPatch[] = [];
  forceEndpoints = 0;
  terminated = false;
  private readonly ls = new Map<string, Set<Listener>>();
  readonly channel: Channel;
  readonly params: StreamingParams;
  readonly bytesPerMs: number;

  constructor(channel: Channel, params: StreamingParams, id: string, configuration?: Record<string, unknown>) {
    this.channel = channel;
    this.params = params;
    this.begin = { type: "Begin", id, expires_at: 0, configuration: configuration ?? { model: params.speech_model, mode: params.mode } };
    const bps = params.encoding === "pcm_mulaw" ? 1 : 2;
    this.bytesPerMs = ((params.sample_rate ?? 16000) * bps) / 1000;
  }
  get sessionId(): string {
    return this.begin.id;
  }
  on(type: string, fn: Listener): () => void {
    let s = this.ls.get(type);
    if (!s) this.ls.set(type, (s = new Set()));
    s.add(fn);
    return () => s.delete(fn);
  }
  private fire(type: string, ev: unknown): void {
    for (const fn of [...(this.ls.get(type) ?? [])]) (fn as (e: unknown) => void)(ev);
  }
  sendAudio(chunk: Uint8Array): boolean {
    if (!this.isOpen) return false;
    const ms = chunk.byteLength / this.bytesPerMs;
    if (ms < 50 || ms > 1000) throw new RangeError(`frame ${ms} ms`);
    this.frames.push(chunk);
    return true;
  }
  get audioMs(): number {
    return this.frames.reduce((s, f) => s + f.byteLength, 0) / this.bytesPerMs;
  }
  updateConfiguration(patch: UpdateConfigurationPatch): boolean {
    if (!this.isOpen) return false;
    this.updates.push(patch);
    return true;
  }
  forceEndpoint(): boolean {
    this.forceEndpoints++;
    return this.isOpen;
  }
  async terminate(): Promise<TerminationMessage | null> {
    if (!this.isOpen) return this.termination;
    this.terminated = true;
    this.termination = { type: "Termination", audio_duration_seconds: this.audioMs / 1000, session_duration_seconds: Math.ceil(this.audioMs / 1000) };
    this.fire("termination", this.termination);
    this.isOpen = false;
    this.fire("close", { code: 1000, reason: "" });
    return this.termination;
  }
  abort(): void {
    this.isOpen = false;
  }
  /** Server → client: a Turn (partial unless `final`). Word times are session ms. */
  turn(order: number, text: string, words: [number, number][], final: boolean): void {
    const m: TurnMessage = {
      type: "Turn",
      turn_order: order,
      turn_is_formatted: true,
      end_of_turn: final,
      transcript: text,
      end_of_turn_confidence: final ? 0.9 : 0.1,
      words: words.map(([s, e], i) => ({ text: text.split(" ")[i] ?? "w", start: s, end: e, confidence: 0.95, word_is_final: final })),
    };
    this.fire("turn", m);
  }
  /** Server closes (with an Error frame first when `error` is given). */
  serverClose(code: number, error?: string): void {
    if (error) this.lastError = { error_code: code, error };
    this.isOpen = false;
    this.fire("close", { code, reason: "See Error message for details" });
  }
}

export class FakeConnect {
  readonly sessions: FakeSession[] = [];
  n = 0;
  failNext: Error | null = null;
  beginConfig: Record<string, unknown> | undefined;
  readonly fn: SttConnect = async ({ channel, params }) => {
    if (this.failNext) {
      const e = this.failNext;
      this.failNext = null;
      throw e;
    }
    const s = new FakeSession(channel, params, `sess-${channel}-${++this.n}`, this.beginConfig);
    this.sessions.push(s);
    return s;
  };
  latest(ch: Channel): FakeSession {
    const s = [...this.sessions].reverse().find((x) => x.channel === ch);
    if (!s) throw new Error(`no session for ${ch}`);
    return s;
  }
}

export function grant(params: { rep: StreamingParams; customer: StreamingParams }, chans: Channel[] = ["rep", "customer"]): SttTokenResponse {
  return {
    status: "granted",
    token: "tok",
    expiresAt: new Date(Date.now() + 10_000).toISOString(),
    params: params as unknown as Extract<SttTokenResponse, { status: "granted" }>["params"],
    sessionIds: Object.fromEntries(chans.map((c) => [c, `ls-${c}-${Math.random().toString(36).slice(2, 7)}`])),
  };
}

export class FakeApi implements SttApi {
  readonly tokenCalls: SttTokenRequest[] = [];
  readonly reports: SessionReport[] = [];
  readonly cancels: string[] = [];
  /** Responses in order; the last one repeats. */
  responses: ((req: SttTokenRequest) => SttTokenResponse)[] = [];
  async token(req: SttTokenRequest): Promise<SttTokenResponse> {
    this.tokenCalls.push(req);
    const f = this.responses.length > 1 ? this.responses.shift()! : this.responses[0]!;
    return f(req);
  }
  async cancel(ticket: string): Promise<void> {
    this.cancels.push(ticket);
  }
  async report(r: SessionReport): Promise<void> {
    this.reports.push(r);
  }
}

export class Sink {
  readonly events: BatonEvent[] = [];
  emit(ev: BatonEvent): void {
    this.events.push(ev);
  }
  of<K extends BatonEvent["type"]>(type: K): Extract<BatonEvent, { type: K }>[] {
    return this.events.filter((e) => e.type === type) as Extract<BatonEvent, { type: K }>[];
  }
}

export const flush = () => new Promise<void>((r) => setTimeout(r, 0));
