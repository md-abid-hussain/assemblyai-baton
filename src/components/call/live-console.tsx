"use client";
/** LiveConsole: /call/[callId] for a real run. The orchestrator (CallSession) drives the store; the console renders it. */
import { useEffect, useMemo, useState } from "react";

import { NOOP_ACTIONS } from "@/client/session/actions";
import { createHttpApi } from "@/client/session/api";
import { getSessionControllers } from "@/client/session/controllers";
import { CallSession } from "@/client/session/orchestrator";
import { ConsoleStoreProvider } from "@/client/store/hooks";
import { createConsoleStore } from "@/client/store/store";
import type { CallManifestEntry } from "@/core/contracts/scenario";

import { ConsoleEnvProvider } from "../common/console-context";
import { CallConsole } from "./call-console";

export function LiveConsole({ callId, call }: { callId: string; call: CallManifestEntry | null }) {
  const store = useMemo(() => createConsoleStore(), []);
  const t0 = useMemo(() => (typeof performance !== "undefined" ? performance.now() : 0), []);
  const now = useMemo(() => () => performance.now() - t0, [t0]);
  const [session, setSession] = useState<CallSession | null>(null);
  useEffect(() => {
    // Created inside the effect so React's dev double-mount disposes one session cleanly and prepares a fresh one.
    store.reset();
    const s = new CallSession({ callId, call, api: createHttpApi(), store, controllers: getSessionControllers(), now });
    setSession(s);
    void s.prepare();
    const onHide = () => s.dispose();
    window.addEventListener("pagehide", onHide);
    return () => {
      window.removeEventListener("pagehide", onHide);
      s.dispose();
    };
  }, [callId, call, store, now]);
  const env = useMemo(
    () => ({
      actions: session ?? NOOP_ACTIONS,
      fixture: null,
      clockNow: now,
      links: { explorer: `/explorer/${encodeURIComponent(callId)}`, evals: "/evals", about: "/about#qa", home: "/" },
    }),
    [session, now, callId],
  );
  return (
    <ConsoleStoreProvider store={store}>
      <ConsoleEnvProvider value={env}>
        <CallConsole />
      </ConsoleEnvProvider>
    </ConsoleStoreProvider>
  );
}
