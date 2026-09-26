"use client";
/**
 * RelayConsole (PLATFORM §7.6): the call console, generalized to any relay.
 *
 *   <RelayConsole callId="…" relayVersionId={null} mode="flagship" />
 *
 * It is today's console throughout — the same store, the same `BatonEvent`s, the same orchestrator over the real
 * WP4 / WP5 / WP5b / WP6 controllers. What changes per relay is data, not code: the case card, stage strip, QA card
 * and phone render from the run's `UiSpec` (`CreateCaseResponseV2.relay`), the human half is transcribed with the
 * relay's own `listening`, and every run carries one `ProvenanceStrip`.
 *
 * `mode` says which chrome the page wears:
 *   - `flagship`  — Baton on `/call/[callId]` (the judge path; nothing extra).
 *   - `test`      — inside the Studio's Test tab: "Back to editor" and the post-run "What the AI inherited" panel
 *                   (WP7·4 builds both; the mode is carried here so the embedding is stable).
 *   - `shared`    — a share page's inline run.
 *   - `published` — a run against a published stored agent. The mic is never offered (§8.3).
 *
 * The AI half's customer inputs follow the mode: the flagship and Test let the judge answer with the mic (WP11's
 * autopilot replaces it when it lands); a shared or published relay never gets a stranger's microphone.
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";

import { NOOP_ACTIONS } from "@/client/session/actions";
import { createHttpApi } from "@/client/session/api";
import { CallSession } from "@/client/session/orchestrator";
import { createBrowserControllers, type BrowserWiringOptions } from "@/client/session/wiring";
import { ConsoleStoreProvider } from "@/client/store/hooks";
import { createConsoleStore } from "@/client/store/store";
import type { CallManifestEntry } from "@/core/contracts/scenario";
import type { MockPhoneProps } from "@/core/contracts/services";

import { ConsoleEnvProvider, type ConsoleEnv } from "../common/console-context";
import { MockPhone } from "../phone/MockPhone";
import { CallConsole } from "./call-console";

export const RELAY_CONSOLE_MODES = ["flagship", "test", "shared", "published"] as const;
export type RelayConsoleMode = (typeof RELAY_CONSOLE_MODES)[number];

/**
 * Who answers the AI as the customer, per mode (WP11's autopilot lands in `createCustomerInput`, not here).
 * **A shared or published relay never gets the mic** (PLATFORM §8.3): a stranger's relay must not talk to a
 * visitor's microphone. `tests/unit/ui/relay-console.test.tsx` pins that.
 */
export const RELAY_CONSOLE_INPUTS: Record<RelayConsoleMode, NonNullable<ConsoleEnv["inputs"]>> = {
  flagship: { autopilot: false, typed: false, mic: true },
  test: { autopilot: false, typed: false, mic: true },
  shared: { autopilot: true, typed: false, mic: false },
  published: { autopilot: true, typed: false, mic: false },
};

export interface RelayConsoleProps {
  callId: string;
  /** The relay version this run pins; null runs the flagship exactly as `/call` always has. */
  relayVersionId: string | null;
  mode: RelayConsoleMode;
  /** The manifest entry when the page already has it (it lets `prepare()` create the Express case up front). */
  call?: CallManifestEntry | null;
  /** `?express=1`: Express starts by itself after a 3 s countdown. */
  autoStart?: "express" | null;
  /**
   * How this call's audio was made, from `src/generated/call-provenance.json` (the page reads it on the server).
   * It overrides the server's human-half segment so a generated take is never labelled a recording.
   */
  callProvenance?: { humanHalf: "recorded" | "simulated"; detail: string } | null;
  /** Page chrome above the console (WP7·4's "Back to editor" and the Studio's own header). */
  header?: ReactNode;
  links?: Partial<ConsoleEnv["links"]>;
  wiring?: BrowserWiringOptions;
}

export function RelayConsole({
  callId,
  relayVersionId,
  mode,
  call = null,
  autoStart = null,
  callProvenance = null,
  header = null,
  links,
  wiring,
}: RelayConsoleProps) {
  const store = useMemo(() => createConsoleStore(), []);
  const t0 = useMemo(() => (typeof performance !== "undefined" ? performance.now() : 0), []);
  const now = useMemo(() => () => performance.now() - t0, [t0]);
  const [session, setSession] = useState<CallSession | null>(null);
  useEffect(() => {
    // Created inside the effect so React's dev double-mount disposes one session cleanly and prepares a fresh one.
    store.reset();
    let s: CallSession | null = null;
    const api = createHttpApi({ visitorToken: () => s?.visitorToken });
    s = new CallSession({
      callId,
      relayVersionId,
      callProvenance,
      call,
      api,
      store,
      controllers: createBrowserControllers({ strictBegin: process.env.NODE_ENV !== "production", ...wiring }),
      now,
      defaultStart: "express",
      log: (level, msg, data) => {
        if (level !== "info") console[level](`[call] ${msg}`, data ?? "");
      },
    });
    const session = s;
    setSession(session);
    void session.prepare();
    const onHide = () => session.dispose("pagehide");
    window.addEventListener("pagehide", onHide);
    return () => {
      window.removeEventListener("pagehide", onHide);
      session.dispose("unmount");
    };
  }, [callId, relayVersionId, callProvenance, call, store, now, wiring]);
  const env = useMemo<Partial<ConsoleEnv>>(
    () => ({
      actions: session ?? NOOP_ACTIONS,
      fixture: null,
      clockNow: now,
      links: { explorer: `/explorer/${encodeURIComponent(callId)}`, evals: "/evals", about: "/about#qa", home: "/", ...links },
      autoStart,
      inputs: RELAY_CONSOLE_INPUTS[mode],
      ...(session
        ? {
            renderPhone: (p: MockPhoneProps & { className?: string }) => <MockPhone {...p} visitorToken={session.visitorToken ?? null} />,
            phoneAuth: () => session.phoneAuth(),
          }
        : {}),
    }),
    [session, now, callId, autoStart, mode, links],
  );
  return (
    <ConsoleStoreProvider store={store}>
      <ConsoleEnvProvider value={env}>
        {header}
        <CallConsole />
      </ConsoleEnvProvider>
    </ConsoleStoreProvider>
  );
}
