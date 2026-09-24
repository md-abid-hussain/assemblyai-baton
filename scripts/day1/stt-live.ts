/**
 * stt-live.ts - WP4's live STT replay in Node, through the SAME client code the browser runs:
 *   CallFeedClock (the CallPlayer's byte clock) → LiveSttChannelManager.feed → FrameBatcher → two live U3.5 Pro
 *   sessions opened by scripts/lib/aai-open.ts (limits guard, ledger, reports, always Terminate).
 * Only the transport differs: the browser gets a temporary token from route #5 and uses the global WebSocket; here the
 * pair is opened with the API key header by aai-open and handed to the manager's `connect` seam.
 *
 * Loaded by stt-replay.ts / stt-grid.ts after they neutralise the `client-only` / `server-only` markers (one Node
 * process imports both the client manager and the server-only ws factory).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { buildSttParams, type TurnTuning } from "../../src/core/aai/stt-params";
import { streamAudioPaced, TurnTracker, type StreamingParams, type TurnMessage } from "../../src/core/aai/streaming";
import { deinterleave, mulawEncode, resampleLinear } from "../../src/core/audio";
import type { CallManifestEntry } from "../../src/core/contracts";
import type { CachedTurnsFile } from "../../src/core/contracts/eval";
import type { TurnInput } from "../../src/core/contracts/turns";
import { CallFeedClock } from "../../src/client/audio/call-clock";
import { LiveSttChannelManager, p50, type SttSessionLike } from "../../src/client/stt/channel-manager";
import type { SttApi } from "../../src/client/stt/api";
import { openStreaming, openStreamingPair, STT_USD_PER_SEC } from "../lib/aai-open";
import { repoRoot } from "../lib/load-env";
import { readWav } from "../lib/wav-fs";
import { buildFixtureCalls, FIXTURE_POLICY } from "./stt-fixtures";
import { entityHits, pct, segmentation, wer, type ScriptTurn } from "./stt-score";

const ROOT = repoRoot();
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface ReplayOptions {
  rate: 8000 | 16000;
  /** undefined = TUNING_8K (8 kHz); null = server defaults; else the grid point. */
  tuning8k?: TurnTuning | null;
  ctxCarry?: "none" | "last_rep_turn";
  label: string;
  /** Write the sessions' Turn messages as a CachedTurnsFile (the cached-replay fixture). */
  recordCachedTo?: string;
  /** Start offset (Express). */
  startOffsetMs?: number;
}

export interface ChannelReport {
  finals: number;
  partials: number;
  wer: number;
  wordRecall: number;
  splits: number;
  merges: number;
  unmatched: number;
  /** recvMs − script turn end (true end of speech). */
  latencyP50: number | null;
  latencyP90: number | null;
  latencyMax: number | null;
  /** recvMs − last word end (STT word time). */
  latencyVsWordEndP50: number | null;
  maxFeedOffsetMs: number;
  framesSent: number;
  text: string;
}

export interface ReplayResult {
  label: string;
  rate: number;
  params: { rep: StreamingParams; customer: StreamingParams };
  channels: Record<"rep" | "customer", ChannelReport>;
  entityRecall: number;
  entitiesMissing: string[];
  beginChecks: { channel: string; ok: boolean; mismatches: string[] }[];
  closes: { channel: string; code: number; errorCode: string | null; text: string | null }[];
  no3007: boolean;
  ctxUpdates: number;
  billedSeconds: Partial<Record<"rep" | "customer", number[]>>;
  estUsd: number;
  wallMs: number;
  providerSessionIds: Partial<Record<"rep" | "customer", string[]>>;
  turns: Pick<TurnInput, "turnId" | "text" | "startMs" | "endMs" | "recvMs">[];
}

interface Fixture {
  call: CallManifestEntry;
  rep: Uint8Array;
  customer: Uint8Array;
  script: ScriptTurn[];
}

function pcmBytes(s: Int16Array): Uint8Array {
  const b = new Uint8Array(s.length * 2);
  const dv = new DataView(b.buffer);
  for (let i = 0; i < s.length; i++) dv.setInt16(i * 2, s[i]!, true);
  return b;
}

export function loadDialogFixture(rate: 8000 | 16000): Fixture {
  const wav = readWav(resolve(ROOT, "spikes/fixtures/dialog_stereo_16k.wav"));
  const [l, r] = deinterleave(wav.samples, 2) as [Int16Array, Int16Array];
  const durationMs = (l.length / 16000) * 1000;
  const call = buildFixtureCalls(durationMs).find((c) => c.format.sampleRate === rate)!;
  const script = (JSON.parse(readFileSync(resolve(ROOT, "spikes/fixtures/dialog_script.json"), "utf8")) as { turns: ScriptTurn[] }).turns;
  if (rate === 16000) return { call, rep: pcmBytes(l), customer: pcmBytes(r), script };
  return { call, rep: mulawEncode(resampleLinear(l, 16000, 8000)), customer: mulawEncode(resampleLinear(r, 16000, 8000)), script };
}

/** Replays the dialog fixture through two live sessions at real time. */
export async function replayFixture(o: ReplayOptions): Promise<ReplayResult> {
  const fx = loadDialogFixture(o.rate);
  const call = fx.call;
  const opt = o.tuning8k === undefined ? {} : { tuning8k: o.tuning8k };
  const params = { rep: buildSttParams(call, FIXTURE_POLICY, "rep", opt), customer: buildSttParams(call, FIXTURE_POLICY, "customer", opt) };
  const startOffsetMs = o.startOffsetMs ?? 0;
  const maxDurationMs = call.durationMs - startOffsetMs + 30_000;
  const pair = await openStreamingPair({ rep: params.rep, customer: params.customer, label: `t-d1-6:${o.label}`, source: "script", maxDurationMs, estUsd: (maxDurationMs / 1000) * STT_USD_PER_SEC });
  const t0 = performance.now();
  const cachedRecs: Record<"rep" | "customer", { recvMs: number; message: Record<string, unknown> }[]> = { rep: [], customer: [] };
  const turns: TurnInput[] = [];
  let mgr: LiveSttChannelManager | null = null;
  try {
    const api: SttApi = {
      token: async (req) => ({
        status: "granted",
        token: "(api-key via aai-open)",
        expiresAt: new Date(Date.now() + 10_000).toISOString(),
        params: params as never,
        sessionIds: req.n === 2 ? { rep: pair.rep.sessionId, customer: pair.customer.sessionId } : {},
      }),
      cancel: async () => undefined,
      report: async () => undefined, // aai-open reports to the limits authority itself
    };
    const m = new LiveSttChannelManager({
      api,
      sink: { emit: () => undefined },
      caseSync: { enqueue: (t) => turns.push(t) },
      now: () => performance.now() - t0,
      connect: async ({ channel }) => pair[channel].session as unknown as SttSessionLike,
      strictBegin: true,
      log: (level, msg, data) => {
        if (level !== "info") console.error(`[${o.label}] ${level}: ${msg} ${JSON.stringify(data ?? {})}`);
      },
    });
    mgr = m;
    for (const ch of ["rep", "customer"] as const) {
      pair[ch].session.on("turn", (msg: TurnMessage) => cachedRecs[ch].push({ recvMs: m.callMs, message: msg as unknown as Record<string, unknown> }));
    }
    const status = await m.open({ caseId: "case_wp4_dev", caseToken: "-", runId: "run_wp4_dev", call, policy: FIXTURE_POLICY, startOffsetMs, ctxCarry: o.ctxCarry ?? "last_rep_turn" });
    if (status !== "live") throw new Error(`manager did not go live: ${status} ${JSON.stringify(m.status)}`);

    // The CallPlayer's byte clock driven by wall time (the browser drives it from worklet ticks).
    const CTX = 48_000;
    const clock = new CallFeedClock({ srcRate: call.format.sampleRate, bytesPerSample: call.format.encoding === "pcm_mulaw" ? 1 : 2, silenceByte: call.format.encoding === "pcm_mulaw" ? 0xff : 0, rep: fx.rep, customer: fx.customer }, CTX);
    clock.start(startOffsetMs);
    const tStart = performance.now();
    let finishing: Promise<unknown> | null = null;
    let done = false;
    for (;;) {
      await sleep(50);
      const frame = Math.floor(((performance.now() - tStart) / 1000) * CTX);
      const playing = clock.callMs < call.durationMs;
      m.feed(clock.tick(frame, playing));
      if (!playing && !finishing) finishing = m.finishAfterSilence(1500).then(() => (done = true));
      if (done) break;
      if (performance.now() - tStart > maxDurationMs) throw new Error("replay overran its cap");
    }
  } finally {
    await pair.close();
  }
  const m = mgr!;
  const wallMs = performance.now() - t0;
  const script = fx.script.filter((t) => t.end_ms > startOffsetMs);
  const report = (ch: "rep" | "customer"): ChannelReport => {
    const side = ch === "rep" ? "left" : "right";
    const ref = script.filter((t) => t.channel === side);
    const fin = turns.filter((t) => t.channel === ch);
    const text = fin.map((t) => t.text).join(" ");
    const w = wer(ref.map((t) => t.text).join(" "), text);
    const seg = segmentation(ref, fin);
    return {
      finals: fin.length,
      partials: m.metrics.partials[ch],
      wer: w.wer,
      wordRecall: w.wordRecall,
      splits: seg.splits,
      merges: seg.merges,
      unmatched: seg.unmatched,
      latencyP50: pct(seg.latencies, 50),
      latencyP90: pct(seg.latencies, 90),
      latencyMax: seg.latencies.length ? Math.max(...seg.latencies) : null,
      latencyVsWordEndP50: p50(m.metrics.finalLatencyMs[ch]),
      maxFeedOffsetMs: m.metrics.maxFeedOffsetMs[ch],
      framesSent: m.metrics.framesSent[ch],
      text,
    };
  };
  const ents = entityHits(turns.map((t) => t.text).join(" "));
  const billed = m.metrics.billedSeconds;
  const totalBilled = Object.values(billed).flat().reduce((s, x) => s + x, 0);
  if (o.recordCachedTo) {
    const file: CachedTurnsFile = { callId: call.callId, variant: "pc_ctx", transcribedAt: new Date().toISOString(), channels: cachedRecs };
    mkdirSync(dirname(o.recordCachedTo), { recursive: true });
    writeFileSync(o.recordCachedTo, `${JSON.stringify(file)}\n`);
  }
  return {
    label: o.label,
    rate: o.rate,
    params,
    channels: { rep: report("rep"), customer: report("customer") },
    entityRecall: Math.round(ents.recall * 1000) / 1000,
    entitiesMissing: ents.missing,
    beginChecks: m.metrics.beginChecks,
    closes: m.metrics.closes.map(({ channel, code, errorCode, text }) => ({ channel, code, errorCode, text })),
    no3007: !m.metrics.closes.some((c) => c.code === 3007),
    ctxUpdates: m.metrics.ctxUpdates,
    billedSeconds: billed,
    estUsd: Math.round(totalBilled * STT_USD_PER_SEC * 10_000) / 10_000,
    wallMs: Math.round(wallMs),
    providerSessionIds: m.metrics.sessionIds,
    turns: turns.map(({ turnId, text, startMs, endMs, recvMs }) => ({ turnId, text, startMs: Math.round(startMs), endMs: Math.round(endMs), recvMs: Math.round(recvMs) })),
  };
}

export interface HinglishResult {
  label: string;
  params: StreamingParams;
  finals: string[];
  hasDigits481529: boolean;
  latinOnly: boolean;
  billedSeconds: number | null;
  estUsd: number;
}

/** T-D1-6's Hinglish run: the code-switch fixture as 8 kHz µ-law with prompt + keyterms (+ TUNING_8K), one session. */
export async function hinglish8k(label = "hinglish-8k"): Promise<HinglishResult> {
  const wav = readWav(resolve(ROOT, "spikes/fixtures/codeswitch_16k.wav"));
  const mono = wav.channels === 1 ? wav.samples : deinterleave(wav.samples, wav.channels)[0]!;
  const bytes = mulawEncode(resampleLinear(mono, wav.sampleRate, 8000));
  const call: Pick<CallManifestEntry, "format" | "language" | "scenarioId"> = { format: { encoding: "pcm_mulaw", sampleRate: 8000 }, language: "hinglish", scenarioId: "s19" };
  const params = buildSttParams(call, FIXTURE_POLICY, "customer");
  const h = await openStreaming({ params, label: `t-d1-6:${label}`, source: "script", maxDurationMs: 60_000, estUsd: 60 * STT_USD_PER_SEC });
  const tracker = new TurnTracker();
  const finals: string[] = [];
  h.session.on("turn", (m) => {
    if (tracker.apply(m) === "final") finals.push(m.transcript);
  });
  let term = null;
  try {
    await streamAudioPaced(h.session, bytes, { sampleRate: 8000, bytesPerSample: 1, chunkMs: 100, tailSilenceMs: 2000 });
    await sleep(800);
  } finally {
    term = await h.close();
  }
  const all = finals.join(" ");
  const billed = term?.session_duration_seconds ?? null;
  return {
    label,
    params,
    finals,
    hasDigits481529: /4\s*8\s*1\s*5\s*2\s*9/.test(all),
    latinOnly: !/[ऀ-ॿ]/.test(all),
    billedSeconds: billed,
    estUsd: billed === null ? 0 : Math.round(billed * STT_USD_PER_SEC * 10_000) / 10_000,
  };
}
