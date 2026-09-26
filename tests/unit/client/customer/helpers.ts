/**
 * Shared fakes for the WP11 customer-input tests: a manual clock, a store stub over WP7's real `UiState`, a Voice
 * Agent that records what it was fed, and a fetch that serves PCM clips from memory (and fails everything else, so
 * a test proves "zero live TTS calls" by construction).
 */
import type { CaseState } from "@/core/contracts/case";
import type { SimAiClipRef } from "@/core/contracts/ext/wp17-sim";
import type { TranscriptLine, Wp7UiState } from "@/core/contracts/ext/wp7-ui";
import type { MicSource } from "@/core/contracts/services";
import { emptyCaseState, S01_POLICY } from "@/client/fixtures/builder";
import { initialUiState, type UiState } from "@/client/store/reduce";
import { s01Context } from "@/client/fixtures/s01";

export { S01_POLICY, emptyCaseState };

// ---------------------------------------------------------------------------------------------- clock

export interface TestClock {
  now(): number;
  setTimeout(cb: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
  /** Run every timer due within `ms`, flushing microtasks between them. */
  advance(ms: number): Promise<void>;
  readonly pending: number;
}

export function testClock(start = 10_000): TestClock {
  let now = start;
  let seq = 1;
  let timers: { id: number; at: number; cb: () => void }[] = [];
  const flush = async () => {
    for (let i = 0; i < 12; i++) await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
  };
  return {
    now: () => now,
    setTimeout(cb, ms) {
      const id = seq++;
      timers.push({ id, at: now + Math.max(0, ms), cb });
      return id;
    },
    clearTimeout(id) {
      timers = timers.filter((t) => t.id !== id);
    },
    async advance(ms) {
      const end = now + ms;
      for (let guard = 0; ; guard++) {
        if (guard > 200) throw new Error("timer loop: something is re-arming without making progress");
        const due = timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        timers = timers.filter((t) => t !== due);
        now = Math.max(now, due.at);
        due.cb();
        await flush();
      }
      now = end;
      await flush();
    },
    get pending() {
      return timers.length;
    },
  };
}

// ---------------------------------------------------------------------------------------------- store

export interface TestStore {
  getState(): Wp7UiState;
  subscribe(cb: () => void): () => void;
  patch(p: Partial<UiState>): void;
  /** A finished spoken agent reply (what `va.reply done` leaves in the store). */
  agentSaid(text: string, id?: string): void;
}

export function testStore(p: Partial<UiState> = {}): TestStore {
  let state: UiState = {
    ...initialUiState(),
    context: s01Context(),
    caseState: emptyCaseState("case1"),
    phase: "ai-listening",
    flowPhase: "ai-listening",
    mode: "live",
    va: { status: "ready", sessionId: "sess_1", code: null, speaking: false, thinking: false, checking: false, activeReplyId: null },
    ...p,
  };
  const ls = new Set<() => void>();
  const notify = () => {
    for (const l of [...ls]) l();
  };
  let n = 0;
  return {
    getState: () => state,
    subscribe(cb) {
      ls.add(cb);
      return () => ls.delete(cb);
    },
    patch(next) {
      state = { ...state, ...next };
      notify();
    },
    agentSaid(text, id) {
      const line: TranscriptLine = {
        id: id ?? `r${++n}`, lane: "ai", text, t: 0, startMs: null, endMs: null, turnId: null, source: "live",
        late: false, cut: false, interrupted: false, words: null, turn: null, kind: "speech",
      };
      state = { ...state, ai: [...state.ai, line] };
      notify();
    },
  };
}

/** A case state with these fields VERIFIED (so `classifyAgentText` can read a value back). */
export function stateWith(fields: Partial<Record<string, string>>): CaseState {
  const cs = emptyCaseState("case1");
  const next = { ...cs.fields };
  for (const [k, v] of Object.entries(fields)) {
    const cur = next[k as keyof typeof next];
    if (cur && v !== undefined) next[k as keyof typeof next] = { ...cur, value: v, status: "VERIFIED" };
  }
  return { ...cs, fields: next, version: cs.version + 1 };
}

// ---------------------------------------------------------------------------------------------- audio

/** A recognisable clip: `n` samples of a constant, so a test can tell two clips apart. */
export const pcmOf = (value: number, samples = 480): Int16Array => new Int16Array(samples).fill(value);
export const bytesOf = (pcm: Int16Array): Uint8Array => new Uint8Array(pcm.buffer.slice(0));

export interface TestVa {
  fed: Int16Array[];
  playCustomerClip(pcm: Int16Array): Promise<{ endCtxMs: number }>;
}
export const testVa = (): TestVa => {
  const fed: Int16Array[] = [];
  return { fed, playCustomerClip: async (pcm) => (fed.push(pcm), { endCtxMs: 0 }) };
};

export interface TestEngine {
  local: { pcm: Int16Array; volume: number | undefined }[];
  micOpens: number;
  micError: Error | null;
  sessions: string[];
  playPcm24k(pcm: Int16Array, opts?: { volume?: number }): Promise<void>;
  openMic(rate: 16000 | 24000): Promise<MicSource>;
  setAudioSession(kind: "playback" | "play-and-record"): void;
}

export function testEngine(o: { micError?: Error | null } = {}): TestEngine & { lastMic: MicSource | null } {
  const e: TestEngine & { lastMic: MicSource | null } = {
    local: [],
    micOpens: 0,
    micError: o.micError ?? null,
    sessions: [],
    lastMic: null,
    async playPcm24k(pcm, opts) {
      e.local.push({ pcm, volume: opts?.volume });
    },
    async openMic() {
      e.micOpens++;
      if (e.micError) throw e.micError;
      let stopped = false;
      const src: MicSource = {
        onFrame: () => () => undefined,
        stop: async () => {
          stopped = true;
        },
        energyDb: () => (stopped ? -100 : -30),
      };
      e.lastMic = src;
      return src;
    },
    setAudioSession(kind) {
      e.sessions.push(kind);
    },
  };
  return e;
}

/** Serves only the URLs it was given; anything else (a live TTS route, say) is a hard 404 the test can assert on. */
export function clipFetch(files: Record<string, Uint8Array | string>): { fetch: typeof fetch; urls: string[] } {
  const urls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    urls.push(url);
    const body = files[url];
    if (body === undefined) return new Response("not found", { status: 404 });
    return typeof body === "string"
      ? new Response(body, { status: 200, headers: { "content-type": "application/json" } })
      : new Response(body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer, { status: 200 });
  }) as typeof fetch;
  return { fetch: fetchImpl, urls };
}

/** A gallery sim's pre-voiced AI half, shaped like `SimCallResolution.aiClips`. */
export const simClips = (base: string, spec: Record<string, string>): Record<string, SimAiClipRef> =>
  Object.fromEntries(
    Object.entries(spec).map(([key, text], i) => [
      key,
      { hash: `${i}`.repeat(1).padStart(64, "0"), text, durationMs: 2000, url: `${base}/clip.${key.replace(/[^a-z0-9]+/gi, "-")}.pcm` } satisfies SimAiClipRef,
    ]),
  );
