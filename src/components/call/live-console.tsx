"use client";
/**
 * LiveConsole: /call/[callId] for a real run. The orchestrator (CallSession) drives the store over the real WP4 / WP5 /
 * WP5b / WP6 controllers (src/client/session/wiring.ts); the console renders the store. Express is the default start;
 * `?express=1` starts it by itself after a 3 s countdown. WP6's MockPhone is mounted here (`renderPhone`), with the
 * pay link and the takeover token read from the session at render time.
 */
import { useEffect, useMemo, useState } from "react";

import { NOOP_ACTIONS } from "@/client/session/actions";
import { createHttpApi } from "@/client/session/api";
import { CallSession } from "@/client/session/orchestrator";
import { createBrowserControllers } from "@/client/session/wiring";
import { ConsoleStoreProvider } from "@/client/store/hooks";
import { createConsoleStore } from "@/client/store/store";
import type { CallManifestEntry } from "@/core/contracts/scenario";
import type { MockPhoneProps } from "@/core/contracts/services";

import { ConsoleEnvProvider, type ConsoleEnv } from "../common/console-context";
import { MockPhone } from "../phone/MockPhone";
import { CallConsole } from "./call-console";

/**
 * The AI half's customer inputs on this page. WP11 (autopilot customer, reply chips, typed replies) is not built yet,
 * so the judge answers with the mic; the phone's own autopilot still simulates an untouched payment.
 */
const LIVE_INPUTS: NonNullable<ConsoleEnv["inputs"]> = { autopilot: false, typed: false, mic: true };

export function LiveConsole({ callId, call, autoStart = null }: { callId: string; call: CallManifestEntry | null; autoStart?: "express" | null }) {
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
      call,
      api,
      store,
      controllers: createBrowserControllers({ strictBegin: process.env.NODE_ENV !== "production" }),
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
  }, [callId, call, store, now]);
  const env = useMemo<Partial<ConsoleEnv>>(
    () => ({
      actions: session ?? NOOP_ACTIONS,
      fixture: null,
      clockNow: now,
      links: { explorer: `/explorer/${encodeURIComponent(callId)}`, evals: "/evals", about: "/about#qa", home: "/" },
      autoStart,
      inputs: LIVE_INPUTS,
      ...(session
        ? {
            renderPhone: (p: MockPhoneProps & { className?: string }) => <MockPhone {...p} visitorToken={session.visitorToken ?? null} />,
            phoneAuth: () => session.phoneAuth(),
          }
        : {}),
    }),
    [session, now, callId, autoStart],
  );
  return (
    <ConsoleStoreProvider store={store}>
      <ConsoleEnvProvider value={env}>
        <CallConsole />
      </ConsoleEnvProvider>
    </ConsoleStoreProvider>
  );
}
