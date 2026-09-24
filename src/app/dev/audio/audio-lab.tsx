"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { buildSttParams } from "@/core/aai/stt-params";
import { pcm16ToBase64 } from "@/core/audio";
import type { CreateCaseResponse } from "@/core/contracts/api";
import type { PolicyRecord } from "@/core/contracts/case";
import type { CachedTurnsFile } from "@/core/contracts/eval";
import type { BatonEvent } from "@/core/contracts/events";
import type { RunPlan } from "@/core/contracts/run";
import type { CallManifestEntry } from "@/core/contracts/scenario";
import type { CallPlayback, MicSource, PacedFeeder, VaOutputPlayer } from "@/core/contracts/services";
import type { TurnInput } from "@/core/contracts/turns";
import type { CallPlayer } from "@/client/audio/call-player";
import { getAudioEngine, type BrowserAudioEngine } from "@/client/audio/engine";
import { HttpCaseSync } from "@/client/case/case-sync";
import { createPageLifecycle, type BrowserPageLifecycle } from "@/client/platform/lifecycle";
import { CachedReplay } from "@/client/replay/cached-replay";
import { HttpSttApi } from "@/client/stt/api";
import { LiveSttChannelManager } from "@/client/stt/channel-manager";
import { loopbackStt, type LoopbackSession } from "@/client/stt/loopback";

type Mode = "loopback" | "cached" | "live";
type FixtureKey = "16k" | "8k";

interface Diag {
  ctxRate: number | null;
  ctxState: string | null;
  isIOS: boolean;
  audioSessionApi: boolean;
  silentLoop: boolean;
  workletError: string | null;
  mode: Mode;
  callId: string | null;
  format: string | null;
  loaded: boolean;
  playing: boolean;
  startOffsetMs: number;
  ticks: number;
  callMs: number;
  wallElapsedMs: number;
  /** (callMs − startOffset) − wall elapsed: the audio clock vs performance.now() (+ = audio ahead). */
  driftMs: number;
  /** callMs advanced / wall elapsed (1.000 = real time). */
  pace: number;
  maxTickGapMs: number;
  hiddenMs: number;
  visibility: { at: number; state: string }[];
  lifecycle: { kind: string; at: number }[];
  ended: boolean;
  sttStatus: Record<string, string> | null;
  sttMetrics: unknown;
  loopback: { channel: string; frames: number; audioMs: number; rejected: number }[];
  finals: { turnId: string; text: string; recvMs: number; source: string }[];
  partials: number;
  cachedLagMs: number[];
  caseVersion: number | null;
  extract: { done: number; failed: number };
  events: number;
  errors: string[];
  va: { firstAudible: { replyId: string; ctxMs: number; lagMs: number }[]; underruns: number };
  feeder: { frames: number; clipEndCtxMs: number | null };
  mic: { open: boolean; frames: number; samples: number; levelDb: number };
  handoff: { endCtxMs: number | null };
}

declare global {
  interface Window {
    __wp4?: Diag;
    __wp4ctl?: Record<string, (...a: never[]) => unknown>;
  }
}

const initialDiag = (): Diag => ({
  ctxRate: null, ctxState: null, isIOS: false, audioSessionApi: false, silentLoop: false, workletError: null, mode: "loopback", callId: null,
  format: null, loaded: false, playing: false, startOffsetMs: 0, ticks: 0, callMs: 0, wallElapsedMs: 0, driftMs: 0, pace: 1, maxTickGapMs: 0,
  hiddenMs: 0, visibility: [], lifecycle: [], ended: false, sttStatus: null, sttMetrics: null, loopback: [], finals: [], partials: 0, cachedLagMs: [],
  caseVersion: null, extract: { done: 0, failed: 0 }, events: 0, errors: [], va: { firstAudible: [], underruns: 0 }, feeder: { frames: 0, clipEndCtxMs: null },
  mic: { open: false, frames: 0, samples: 0, levelDb: -120 }, handoff: { endCtxMs: null },
});

function tone24k(ms: number, hz: number, amp = 0.3): Int16Array {
  const n = Math.round((24_000 * ms) / 1000);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.round(Math.sin((2 * Math.PI * hz * i) / 24_000) * amp * 32767);
  return out;
}

const now = () => performance.now();

export function AudioLab() {
  const [mode, setMode] = useState<Mode>("loopback");
  const [fixture, setFixture] = useState<FixtureKey>("8k");
  const [diag, setDiag] = useState<Diag>(initialDiag);
  const d = useRef<Diag>(initialDiag());
  const engine = useRef<BrowserAudioEngine | null>(null);
  const lifecycle = useRef<BrowserPageLifecycle | null>(null);
  const player = useRef<CallPlayback | null>(null);
  const call = useRef<CallManifestEntry | null>(null);
  const policy = useRef<PolicyRecord | null>(null);
  const mgr = useRef<LiveSttChannelManager | null>(null);
  const cached = useRef<CachedReplay | null>(null);
  const caseSync = useRef<HttpCaseSync | null>(null);
  const loop = useRef<LoopbackSession[]>([]);
  const vaOut = useRef<VaOutputPlayer | null>(null);
  const feeder = useRef<PacedFeeder | null>(null);
  const mic = useRef<MicSource | null>(null);
  const live = useRef<{ create: CreateCaseResponse; run: RunPlan } | null>(null);
  const t0 = useRef(now());
  const startWall = useRef(0);
  const lastTickWall = useRef(0);
  const hiddenAt = useRef<number | null>(null);

  const err = useCallback((m: string) => {
    d.current.errors.push(`${Math.round(now() - t0.current)} ms: ${m}`);
  }, []);

  const sink = useRef({
    emit: (ev: BatonEvent) => {
      d.current.events++;
      if (ev.type === "stt.final") d.current.finals.push({ turnId: ev.turn.turnId, text: ev.turn.text, recvMs: Math.round(ev.turn.recvMs), source: ev.turn.source });
      else if (ev.type === "stt.partial") d.current.partials++;
      else if (ev.type === "error") err(`${ev.code}: ${ev.message}`);
      else if (ev.type === "case.state") d.current.caseVersion = ev.state.version;
    },
  });

  // UI refresh (display only; nothing realtime depends on it) + window.__wp4 for browser checks.
  useEffect(() => {
    const id = setInterval(() => {
      const e = engine.current;
      const x = d.current;
      if (e) {
        x.ctxRate = e.ctx.sampleRate;
        x.ctxState = e.ctx.state;
        x.isIOS = e.isIOS;
        x.audioSessionApi = e.diag.audioSessionApi;
        x.silentLoop = e.diag.silentLoop;
        x.workletError = e.diag.workletError;
      }
      if (mgr.current) {
        x.sttStatus = { ...mgr.current.status };
        x.sttMetrics = mgr.current.metrics;
      }
      x.loopback = loop.current.map((s) => ({ channel: s.sessionId, frames: s.frames, audioMs: Math.round(s.audioMs), rejected: s.rejected }));
      if (cached.current) x.cachedLagMs = cached.current.emissions.map((m) => Math.round(m.emittedAtMs - m.recvMs));
      if (caseSync.current) {
        const o = caseSync.current.outcomes;
        x.extract = { done: o.filter((q) => q.status === "done").length, failed: o.filter((q) => q.status === "failed").length };
      }
      if (vaOut.current) x.va.underruns = vaOut.current.underruns;
      if (mic.current) x.mic.levelDb = Math.round(mic.current.energyDb());
      if (lifecycle.current) x.lifecycle = lifecycle.current.log.map((l) => ({ kind: l.kind, at: Math.round(l.at) }));
      window.__wp4 = x;
      setDiag({ ...x, finals: x.finals.slice(-30), errors: x.errors.slice(-10) });
    }, 250);
    const onVis = () => {
      d.current.visibility.push({ at: Math.round(now() - t0.current), state: document.visibilityState });
      if (document.visibilityState === "hidden") hiddenAt.current = now();
      else if (hiddenAt.current !== null) {
        d.current.hiddenMs += now() - hiddenAt.current;
        hiddenAt.current = null;
      }
    };
    document.addEventListener("visibilitychange", onVis);
    lifecycle.current = createPageLifecycle();
    const offPause = lifecycle.current.onPause((reason) => {
      sink.current.emit({ t: now() - t0.current, type: "paused", reason, resumed: false });
      if (mgr.current) void mgr.current.pause();
    });
    const offResume = lifecycle.current.onResume(() => {
      if (mgr.current) void mgr.current.resume();
    });
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVis);
      offPause();
      offResume();
      lifecycle.current?.dispose();
    };
  }, []);

  const unlock = useCallback(() => {
    // Synchronous, inside the tap: create the one context, resume it, iOS audio session = playback.
    let e: BrowserAudioEngine;
    try {
      e = getAudioEngine();
    } catch (e2) {
      // No Web Audio (e.g. Playwright's Windows WebKit build) or no AudioWorklet (insecure context: http on a LAN IP).
      err(`${e2 instanceof Error ? e2.message : String(e2)}; isSecureContext=${String(window.isSecureContext)}`);
      return;
    }
    e.unlockSync();
    engine.current = e;
    lifecycle.current?.attachContext(e.ctx);
    void e.whenRunning(300).then((ok) => {
      if (!ok) err("AudioContext not running after 300 ms: show 'Tap to enable sound'");
    });
  }, [err]);

  const reset = useCallback(async () => {
    if (mgr.current) await mgr.current.terminateAll();
    mgr.current = null;
    player.current?.dispose();
    player.current = null;
    cached.current = null;
    caseSync.current = null;
    loop.current = [];
    const keep = { visibility: d.current.visibility, lifecycle: d.current.lifecycle };
    d.current = { ...initialDiag(), ...keep, mode };
  }, [mode]);

  const load = useCallback(async () => {
    const e = engine.current;
    if (!e) return err("unlock audio first");
    await reset();
    const params = new URLSearchParams(window.location.search);
    const callId = params.get("callId");
    try {
      if (mode === "live") {
        if (!callId) throw new Error("live mode needs ?callId=<a published call> (routes #3/#5a/#5 from WP2/WP3)");
        const res = await fetch("/api/cases", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: "watch", callId }) });
        if (!res.ok) throw new Error(`POST /api/cases → HTTP ${res.status} (WP3 route #3 not merged yet?)`);
        const create = (await res.json()) as CreateCaseResponse;
        const auth = { "content-type": "application/json", authorization: `Bearer ${create.caseToken}`, ...(create.visitorToken ? { "x-baton-visitor": create.visitorToken } : {}) };
        const rr = await fetch("/api/runs", { method: "POST", headers: auth, body: JSON.stringify({ caseId: create.caseId, callId, express: false }) });
        if (!rr.ok) throw new Error(`POST /api/runs → HTTP ${rr.status} (WP2 route #5a not merged yet?)`);
        const run = (await rr.json()) as RunPlan;
        live.current = { create, run };
        if (!create.call) throw new Error("case has no call");
        call.current = create.call;
        policy.current = create.policy;
        player.current = await e.loadCall(create.call, create.assets);
      } else {
        const man = (await (await fetch("/fixtures/dialog/calls.json")).json()) as { calls: CallManifestEntry[]; policy: PolicyRecord };
        const entry = man.calls.find((c) => c.callId === `fixture-dialog-${fixture}`)!;
        call.current = entry;
        policy.current = man.policy;
        player.current = await e.loadCall(entry, entry.assets!);
      }
      d.current.loaded = true;
      d.current.callId = call.current.callId;
      d.current.format = `${call.current.format.encoding}/${call.current.format.sampleRate}`;
      // `?hold=1`: keep the sessions open after the recording ends (they are fed silence on the same clock), for the
      // 3-minute drift / feed-offset check with the 69 s fixture. Default: finish after 1.5 s of silence (§5.1.8).
      const hold = new URLSearchParams(window.location.search).get("hold") === "1";
      player.current.onEnded(() => {
        d.current.ended = true;
        if (mgr.current && !hold) void mgr.current.finishAfterSilence(1500);
      });
      player.current.onTick((t) => {
        const w = now();
        const x = d.current;
        if (lastTickWall.current) x.maxTickGapMs = Math.max(x.maxTickGapMs, w - lastTickWall.current);
        lastTickWall.current = w;
        x.ticks++;
        x.callMs = t.callMs;
        x.wallElapsedMs = w - startWall.current;
        x.driftMs = t.callMs - x.startOffsetMs - x.wallElapsedMs;
        x.pace = x.wallElapsedMs > 0 ? (t.callMs - x.startOffsetMs) / x.wallElapsedMs : 1;
        mgr.current?.feed(t);
        if (!mgr.current) cached.current?.onTick(t.callMs);
      });
    } catch (e2) {
      err(e2 instanceof Error ? e2.message : String(e2));
    }
  }, [err, fixture, mode, reset]);

  const start = useCallback(
    async (express: boolean) => {
      const p = player.current;
      const c = call.current;
      const pol = policy.current;
      if (!p || !c || !pol) return err("load a call first");
      const startOffsetMs = express && c.decisionPointMs !== null ? Math.max(0, c.decisionPointMs - 25_000) : 0;
      d.current.startOffsetMs = startOffsetMs;
      const caseId = live.current?.create.caseId ?? "case_dev_audio";
      const cachedUrl = mode === "live" ? live.current?.create.cachedTurnsUrl ?? null : `/fixtures/dialog/cached-turns.${fixture}.json`;
      caseSync.current =
        mode === "live" && live.current
          ? new HttpCaseSync({ caseToken: live.current.create.caseToken, ...(live.current.create.visitorToken ? { visitorToken: live.current.create.visitorToken } : {}), sink: sink.current, now: () => now() - t0.current })
          : null;
      const enqueue = (t: TurnInput) => caseSync.current?.enqueue(t);
      cached.current = new CachedReplay({ caseId, sink: sink.current, caseSync: { enqueue }, now: () => now() - t0.current, url: cachedUrl });
      if (cachedUrl) await cached.current.ensureLoaded().catch((e3: unknown) => err(`cached turns: ${e3 instanceof Error ? e3.message : String(e3)}`));
      if (mode === "cached") {
        cached.current.activate("both", startOffsetMs, "dev: cached mode");
      } else {
        const stt =
          mode === "live" && live.current
            ? { api: new HttpSttApi({ caseToken: live.current.create.caseToken, ...(live.current.create.visitorToken ? { visitorToken: live.current.create.visitorToken } : {}) }) }
            : (() => {
                const params = { rep: buildSttParams(c, pol, "rep"), customer: buildSttParams(c, pol, "customer") };
                // The loopback sessions play the fixture's recorded Turn messages "live" (manager → CaseSync path, $0).
                const file: CachedTurnsFile | null = cached.current?.data ?? null;
                const lb = loopbackStt(params, file, startOffsetMs);
                loop.current = lb.sessions;
                return { api: lb.api, connect: lb.connect };
              })();
        mgr.current = new LiveSttChannelManager({
          ...stt,
          sink: sink.current,
          caseSync: { enqueue },
          cached: cached.current,
          now: () => now() - t0.current,
          strictBegin: mode === "live",
          log: (level, msg, data) => level !== "info" && err(`${msg} ${JSON.stringify(data ?? {})}`),
        });
        const r = await mgr.current.open({
          caseId, caseToken: live.current?.create.caseToken ?? "-", runId: live.current?.run.runId ?? "run_dev_audio", call: c, policy: pol, startOffsetMs,
          ctxCarry: "last_rep_turn",
        });
        if (r !== "live") err(`stt open: ${r}`);
      }
      startWall.current = now();
      lastTickWall.current = 0;
      d.current.playing = true;
      p.start(startOffsetMs);
    },
    [err, fixture, mode],
  );

  const stop = useCallback(() => {
    player.current?.stop(30);
    d.current.playing = false;
  }, []);

  const handoff = useCallback(async () => {
    const p = player.current as CallPlayer | null;
    const h = call.current?.handoff;
    if (!p || !h) return err("no call/handoff");
    p.stop(30);
    const r = await p.playHandoffClip(h);
    d.current.handoff.endCtxMs = Math.round(r.endCtxMs);
  }, [err]);

  const vaTone = useCallback(() => {
    const e = engine.current;
    if (!e) return err("unlock audio first");
    if (!vaOut.current) {
      vaOut.current = e.createVaOutput();
      vaOut.current.onFirstAudiblePlayed((replyId, ctxMs) => {
        d.current.va.firstAudible.push({ replyId, ctxMs: Math.round(ctxMs), lagMs: Math.round(ctxMs - pushedAt.current) });
      });
    }
    const id = `reply-${d.current.va.firstAudible.length + 1}`;
    const pcm = tone24k(1200, 440);
    pushedAt.current = e.nowMs();
    for (let off = 0; off < pcm.length; off += 240) vaOut.current.push(pcm16ToBase64(pcm.subarray(off, off + 240)), id, true);
  }, [err]);
  const pushedAt = useRef(0);

  const feedClip = useCallback(() => {
    const e = engine.current;
    if (!e) return err("unlock audio first");
    if (!feeder.current) {
      feeder.current = e.createFeeder();
      feeder.current.start(() => {
        d.current.feeder.frames++;
      });
    }
    void feeder.current.enqueueClip(tone24k(1000, 300)).then((r) => (d.current.feeder.clipEndCtxMs = Math.round(r.endCtxMs)));
  }, [err]);

  const openMic = useCallback(async () => {
    const e = engine.current;
    if (!e) return err("unlock audio first");
    if (mic.current) {
      await mic.current.stop();
      mic.current = null;
      d.current.mic.open = false;
      return;
    }
    try {
      mic.current = await e.openMic(16000);
      d.current.mic.open = true;
      mic.current.onFrame((pcm) => {
        d.current.mic.frames++;
        d.current.mic.samples += pcm.length;
      });
    } catch (e2) {
      err(`mic: ${e2 instanceof Error ? e2.message : String(e2)}`);
    }
  }, [err]);

  useEffect(() => {
    window.__wp4ctl = {
      unlock, load: () => load(), start: (express: never) => start(Boolean(express)), stop, handoff: () => handoff(), vaTone, feedClip,
      setMode: (m: never) => setMode(m as Mode), setFixture: (f: never) => setFixture(f as FixtureKey),
      terminate: () => mgr.current?.terminateAll(),
    };
  }, [unlock, load, start, stop, handoff, vaTone, feedClip]);

  const x = diag;
  return (
    <div className="mt-4 space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={unlock} data-testid="unlock">Unlock audio</Button>
        <select className="rounded border px-2 py-1 text-sm" value={mode} onChange={(e) => setMode(e.target.value as Mode)} data-testid="mode">
          <option value="loopback">loopback STT ($0)</option>
          <option value="cached">cached replay</option>
          <option value="live">live (?callId=, needs G1 routes)</option>
        </select>
        <select className="rounded border px-2 py-1 text-sm" value={fixture} onChange={(e) => setFixture(e.target.value as FixtureKey)} data-testid="fixture">
          <option value="8k">fixture 8 kHz µ-law</option>
          <option value="16k">fixture 16 kHz PCM16</option>
        </select>
        <Button variant="outline" onClick={() => void load()} data-testid="load">Load</Button>
        <Button variant="outline" onClick={() => void start(false)} data-testid="start">Start</Button>
        <Button variant="outline" onClick={() => void start(true)} data-testid="express">Express</Button>
        <Button variant="outline" onClick={stop} data-testid="stop">Stop</Button>
        <Button variant="outline" onClick={() => void handoff()} data-testid="handoff">Handoff clip</Button>
        <Button variant="outline" onClick={vaTone} data-testid="va">VA tone</Button>
        <Button variant="outline" onClick={feedClip} data-testid="feed">Feeder clip</Button>
        <Button variant="outline" onClick={() => void openMic()} data-testid="mic">{x.mic.open ? "Stop mic" : "Open mic"}</Button>
      </div>
      <div className="flex flex-wrap gap-2 text-xs">
        <Badge variant="outline">ctx {x.ctxState ?? "none"} @ {x.ctxRate ?? "?"} Hz</Badge>
        <Badge variant="outline">iOS {String(x.isIOS)} · audioSession {String(x.audioSessionApi)} · silent loop {String(x.silentLoop)}</Badge>
        <Badge variant="outline">{x.callId ?? "no call"} {x.format ?? ""}</Badge>
        <Badge variant="outline">call {(x.callMs / 1000).toFixed(2)} s · ticks {x.ticks} · pace {x.pace.toFixed(4)} · drift {x.driftMs.toFixed(1)} ms</Badge>
        <Badge variant="outline">max tick gap {x.maxTickGapMs.toFixed(0)} ms · hidden {(x.hiddenMs / 1000).toFixed(1)} s</Badge>
        <Badge variant="outline">STT {x.sttStatus ? `${x.sttStatus.rep}/${x.sttStatus.customer}` : "-"}</Badge>
        <Badge variant="outline">finals {x.finals.length} · partials {x.partials}</Badge>
        {x.workletError ? <Badge variant="destructive">worklet: {x.workletError}</Badge> : null}
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <section>
          <h2 className="text-sm font-medium">Finals (call clock)</h2>
          <ul className="mt-1 max-h-72 overflow-auto font-mono text-xs" data-testid="finals">
            {x.finals.map((f) => (
              <li key={f.turnId} className={f.turnId.startsWith("rep") ? "text-blue-700" : "text-emerald-700"}>
                {(f.recvMs / 1000).toFixed(2)} {f.turnId} [{f.source}] {f.text}
              </li>
            ))}
          </ul>
        </section>
        <section>
          <h2 className="text-sm font-medium">Diagnostics</h2>
          <pre className="mt-1 max-h-72 overflow-auto rounded bg-muted p-2 text-[10px]" data-testid="diag">
            {JSON.stringify({ loopback: x.loopback, va: x.va, feeder: x.feeder, mic: x.mic, handoff: x.handoff, extract: x.extract, caseVersion: x.caseVersion, lifecycle: x.lifecycle, visibility: x.visibility.slice(-6), errors: x.errors }, null, 1)}
          </pre>
        </section>
      </div>
    </div>
  );
}
