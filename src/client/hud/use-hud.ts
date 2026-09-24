/**
 * client/hud/use-hud.ts - React binding for the latency HUD: `useHud(hud, repFirst)` returns the view model and
 * re-renders on every HUD change (useSyncExternalStore over the HUD's stable snapshot). WP7's HUD component
 * (src/components/hud/**) renders it.
 */
"use client";
import "client-only";

import { useCallback, useMemo, useSyncExternalStore } from "react";

import type { HudSnapshot, LatencyHudExt } from "@/core/contracts/ext/wp5b-va";

import { hudViewModel, type HudViewModel } from "./view-model";

const EMPTY: HudSnapshot = { metrics: {}, sessionIds: {}, underruns: 0, slowNetwork: false, marks: [] };

export function useHud(hud: LatencyHudExt | null, repFirst: string): HudViewModel {
  const subscribe = useCallback((cb: () => void) => (hud ? hud.subscribe(cb) : () => undefined), [hud]);
  const getSnapshot = useCallback(() => (hud ? hud.snapshot() : EMPTY), [hud]);
  const snap = useSyncExternalStore(subscribe, getSnapshot, () => EMPTY);
  return useMemo(() => hudViewModel(snap, { repFirst }), [snap, repFirst]);
}
