"use client";
/**
 * The console's non-state inputs: button actions, the MockPhone slot (WP6 mounts its component here), whether a
 * fixture drives the page, and outbound links.
 */
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

import { NOOP_ACTIONS, type ConsoleActions } from "@/client/session/actions";
import type { MockPhoneProps } from "@/core/contracts/services";

export interface ConsoleEnv {
  actions: ConsoleActions;
  /** WP6's MockPhone (DESIGN S6). When absent the console shows its read-only phone preview. */
  renderPhone?: (p: MockPhoneProps) => ReactNode;
  takeoverToken?: string;
  paymentId?: string | null;
  /** "FIXTURE" badge: the page is driven by a dev event log, not a live run. */
  fixture: string | null;
  links: { explorer: string; evals: string; about: string; home: string };
  /** The page clock (the same clock as BatonEvent.t): the fixture player's clock, or ms since the session start. */
  clockNow: () => number;
}

const DEFAULT_ENV: ConsoleEnv = {
  actions: NOOP_ACTIONS,
  fixture: null,
  clockNow: () => (typeof performance !== "undefined" ? performance.now() : 0),
  links: { explorer: "/explorer", evals: "/evals", about: "/about#qa", home: "/" },
};

const Ctx = createContext<ConsoleEnv>(DEFAULT_ENV);

export function ConsoleEnvProvider({ value, children }: { value: Partial<ConsoleEnv>; children: ReactNode }) {
  return <Ctx.Provider value={{ ...DEFAULT_ENV, ...value, links: { ...DEFAULT_ENV.links, ...value.links } }}>{children}</Ctx.Provider>;
}

export const useConsoleEnv = (): ConsoleEnv => useContext(Ctx);
export const useActions = (): ConsoleActions => useContext(Ctx).actions;

/** A wall clock that ticks every `ms` while `active` (elapsed timers, the stepper's live ms). */
export function useNow(active: boolean, ms = 100): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [active, ms]);
  return now;
}

/** True when the viewport is at least `px` wide (matchMedia). `initial` is used for SSR and the first render. */
export function useMinWidth(px: number, initial = true): boolean {
  const [ok, setOk] = useState(initial);
  useEffect(() => {
    const mq = window.matchMedia(`(min-width: ${px}px)`);
    const on = () => setOk(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [px]);
  return ok;
}
