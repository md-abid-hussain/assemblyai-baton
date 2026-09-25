"use client";
/**
 * FixtureConsole: the call console driven by a BatonEvent fixture log (dev only; /dev/ui?fixture=… and
 * /call/<id>?fixture=…). Buttons map onto the fixture timeline; a small dev bar (hidden with chrome=0) plays, pauses,
 * changes speed, scrubs and jumps between S2 states. Query: fixture, at (ms | end | <phase>[:end][+ms]), speed,
 * play=1, chrome=0, express=1 (the landing CTA's 3 s countdown), phone=wp6 (WP6's real MockPhone over a no-network
 * fixture payments client instead of the read-only preview).
 */
import { FastForwardIcon, PauseIcon, PlayIcon, RotateCcwIcon } from "lucide-react";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { toast } from "sonner";

import { DEFAULT_FIXTURE, FIXTURES, fixtureLog } from "@/client/fixtures";
import { createFixturePaymentsClient, FIXTURE_PAYMENT_ID, FIXTURE_TAKEOVER_TOKEN } from "@/client/fixtures/phone-client";
import { FixturePlayer, phaseSpans, resolveAt } from "@/client/fixtures/player";
import type { ConsoleActions } from "@/client/session/actions";
import { clipWindowFor } from "@/client/session/evidence";
import { ConsoleStoreProvider } from "@/client/store/hooks";
import { formatCallClock, formatMmSs } from "@/client/store/selectors";
import { createConsoleStore } from "@/client/store/store";
import type { MockPhoneProps } from "@/core/contracts/services";
import { cn } from "@/lib/utils";

import { MockPhone } from "../phone/MockPhone";
import { ConsoleEnvProvider, type ConsoleEnv } from "../common/console-context";
import { CallConsole } from "./call-console";

export interface FixtureConsoleProps {
  fixture: string | null;
  at: string | null;
  speed: number;
  autoplay: boolean;
  chrome: boolean;
  basePath: string;
  /** Start Express by itself after the 3 s countdown (`/call/[id]?express=1`). */
  express?: boolean;
  /** "wp6": mount WP6's MockPhone over a fixture payments client; default: the read-only preview. */
  phone?: "preview" | "wp6";
}

export function FixtureConsole(p: FixtureConsoleProps) {
  const name = p.fixture && fixtureLog(p.fixture) ? p.fixture : DEFAULT_FIXTURE;
  const log = useMemo(() => fixtureLog(name) ?? [], [name]);
  const store = useMemo(() => createConsoleStore(), []);
  const player = useMemo(() => new FixturePlayer(store, log), [store, log]);

  useEffect(() => {
    player.speed = p.speed;
    const target = resolveAt(log, p.at);
    // Always show the pre-flight entries (context + run plan) at least.
    player.seek(target ?? 1000);
    if (p.autoplay) player.play();
    return () => player.dispose();
  }, [player, log, p.at, p.speed, p.autoplay]);

  const actions = useMemo<ConsoleActions>(() => {
    const note = (what: string): void => {
      toast.message(`Fixture: ${what}`, { description: "In a live run this goes to the orchestrator." });
    };
    const seekTo = (pred: (e: (typeof log)[number]) => boolean) => {
      const e = log.find(pred);
      if (e) player.seek(e.t);
      player.play();
    };
    return {
      start: () => player.playFrom((e) => e.type === "ui.start"),
      pass: () => seekTo((e) => e.type === "takeover.phase" && e.phase === "armed"),
      stopPlayback: () => player.pause(),
      resume: () => {
        store.dispatch({ t: player.clock(), type: "paused", reason: "ios_background", resumed: true });
        note("resumed through the reconnect path");
      },
      watchCachedNow: () => note("switching to the labelled cached replay"),
      retry: () => player.seek(1000),
      watchReplay: () => note("playing the recorded AI session bundle"),
      playEvidence: async (ev) => {
        const turn = store.getState().human.find((l) => l.turnId === ev.turnId)?.turn ?? null;
        const w = clipWindowFor(ev, turn, store.getState().context?.durationMs ?? 0);
        toast.message(`▶ ${ev.channel} clip ${formatCallClock(w.fromMs)}–${formatCallClock(w.toMs)}`, { description: `“${ev.quote}” · call ducked to 20%` });
        await new Promise((r) => setTimeout(r, Math.min(2500, w.toMs - w.fromMs)));
      },
      playTurn: async (l) => {
        toast.message(`▶ ${l.lane} line ${formatMmSs(l.startMs)}`, { description: l.text.slice(0, 90) });
        await new Promise((r) => setTimeout(r, 1200));
      },
      setAutopilot: (on) => store.act({ t: player.clock(), type: "ui.autopilot", on }),
      playSuggestion: async (s) => note(`the customer says “${s.text}”`),
      sendTyped: async (t) => note(`typed reply “${t}” → TTS → Voice Agent`),
      toggleMic: async () => {
        note("the mic stays off in a fixture");
        return false;
      },
      askForDaniel: () => note("asking the AI to hand back to the rep"),
      endCall: () => note("ending the AI session"),
      unlockAudio: () => store.act({ t: player.clock(), type: "ui.audio-locked", locked: false }),
      setPhoneState: (st) => {
        if (store.getState().phone.state !== st) store.dispatch({ t: player.clock(), type: "phone.state", state: st });
      },
    };
  }, [player, store, log]);

  const wp6Phone = p.phone === "wp6";
  const phoneClient = useMemo(
    () => (wp6Phone ? createFixturePaymentsClient({ caseState: () => store.getState().caseState, policy: () => store.getState().context?.policy ?? null }) : null),
    [wp6Phone, store],
  );
  const env = useMemo<Partial<ConsoleEnv>>(
    () => ({
      actions,
      fixture: name,
      clockNow: () => player.clock(),
      links: { explorer: "/explorer/s01", evals: "/evals", about: "/about#qa", home: "/" },
      autoStart: p.express ? "express" : null,
      ...(phoneClient
        ? {
            renderPhone: (props: MockPhoneProps & { className?: string }) => <MockPhone {...props} readOnly={false} client={phoneClient} />,
            phoneAuth: () => ({ paymentId: store.getState().phone.sms.length ? FIXTURE_PAYMENT_ID : null, takeoverToken: FIXTURE_TAKEOVER_TOKEN }),
          }
        : {}),
    }),
    [actions, name, player, p.express, phoneClient, store],
  );

  return (
    <ConsoleStoreProvider store={store}>
      <ConsoleEnvProvider value={env}>
        <CallConsole />
        {p.chrome ? <DevBar player={player} name={name} basePath={p.basePath} /> : null}
      </ConsoleEnvProvider>
    </ConsoleStoreProvider>
  );
}

function DevBar({ player, name, basePath }: { player: FixturePlayer; name: string; basePath: string }) {
  const [open, setOpen] = useState(true);
  const version = useSyncExternalStore(
    (cb) => player.onChange(cb),
    () => `${player.playing}-${player.speed}`,
    () => "ssr",
  );
  const [, force] = useState(0);
  useEffect(() => {
    if (!player.playing) return;
    const id = setInterval(() => force((x) => x + 1), 250);
    return () => clearInterval(id);
  }, [player, version]);
  const spans = useMemo(() => phaseSpans(player.log), [player]);
  const t = player.clock();
  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="fixed bottom-3 left-3 z-50 rounded-full bg-(--bt-ink) px-3 py-1.5 text-xs font-semibold text-(--bt-panel) shadow-lg">
        Fixture controls
      </button>
    );
  }
  return (
    <div className="fixed bottom-3 left-3 z-50 w-[min(560px,calc(100vw-24px))] rounded-xl border border-(--bt-line-strong) bg-(--bt-panel)/95 p-2.5 text-xs text-(--bt-ink) shadow-2xl backdrop-blur" role="region" aria-label="Fixture controls (dev)">
      <div className="flex items-center gap-2">
        <label className="sr-only" htmlFor="fx-select">
          Fixture
        </label>
        <select
          id="fx-select"
          value={name}
          onChange={(e) => {
            window.location.href = `${basePath}?fixture=${encodeURIComponent(e.target.value)}`;
          }}
          className="h-7 min-w-0 flex-1 rounded border border-(--bt-line-strong) bg-(--bt-panel) px-1"
        >
          {FIXTURES.map((f) => (
            <option key={f.name} value={f.name}>
              {f.name}: {f.title}
            </option>
          ))}
        </select>
        <button type="button" onClick={() => (player.playing ? player.pause() : player.play())} className="inline-flex size-7 items-center justify-center rounded bg-(--bt-ink) text-(--bt-panel)" aria-label={player.playing ? "Pause fixture" : "Play fixture"}>
          {player.playing ? <PauseIcon className="size-3.5" aria-hidden="true" /> : <PlayIcon className="size-3.5" aria-hidden="true" />}
        </button>
        <button type="button" onClick={() => player.seek(1000)} className="inline-flex size-7 items-center justify-center rounded border border-(--bt-line-strong)" aria-label="Restart fixture">
          <RotateCcwIcon className="size-3.5" aria-hidden="true" />
        </button>
        {[1, 2, 4, 8].map((x) => (
          <button key={x} type="button" onClick={() => player.setSpeed(x)} className={cn("h-7 rounded px-1.5 font-semibold", player.speed === x ? "bg-(--ai) text-white" : "border border-(--bt-line-strong)")} aria-pressed={player.speed === x}>
            {x}×
          </button>
        ))}
        <button type="button" onClick={() => setOpen(false)} className="h-7 rounded px-1.5 text-(--bt-muted)" aria-label="Hide fixture controls">
          <FastForwardIcon className="size-3.5 rotate-90" aria-hidden="true" />
        </button>
      </div>
      <div className="mt-2 flex items-center gap-2">
        <span className="bt-mono w-12 text-right">{formatMmSs(t)}</span>
        <input type="range" min={0} max={player.endT} step={100} value={Math.round(t)} onChange={(e) => player.seek(Number(e.target.value))} className="flex-1 accent-(--ai)" aria-label="Fixture time" />
        <span className="bt-mono w-12">{formatMmSs(player.endT)}</span>
      </div>
      <div className="mt-1.5 flex flex-wrap gap-1">
        {spans
          .filter((s, i, xs) => xs.findIndex((x) => x.phase === s.phase) === i)
          .map((s) => (
            <button key={s.phase} type="button" onClick={() => player.seek(Math.max(s.startT, s.endT - 1))} className={cn("rounded-full border px-2 py-0.5", t >= s.startT && t <= s.endT ? "border-(--ai) bg-(--ai-bg) text-(--ai-fg)" : "border-(--bt-line-strong)")}>
              {s.phase}
            </button>
          ))}
      </div>
    </div>
  );
}
