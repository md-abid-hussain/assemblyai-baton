"use client";
/**
 * client/store/hooks.ts - React bindings for the console store: a context plus `useBaton(selector)`, which
 * re-renders a component only when its selected slice changes (reference equality, or a custom `eq`).
 */
import "client-only";

import { createContext, createElement, useCallback, useContext, useRef, useSyncExternalStore, type ReactNode } from "react";

import type { UiState } from "./reduce";
import type { ConsoleStore } from "./store";

const StoreContext = createContext<ConsoleStore | null>(null);

export function ConsoleStoreProvider({ store, children }: { store: ConsoleStore; children: ReactNode }) {
  return createElement(StoreContext.Provider, { value: store }, children);
}

export function useConsoleStore(): ConsoleStore {
  const s = useContext(StoreContext);
  if (!s) throw new Error("useConsoleStore: no ConsoleStoreProvider above this component");
  return s;
}

export function shallowEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || !a || !b) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) if (!Object.is((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false;
  return true;
}

export function useBaton<T>(selector: (s: UiState) => T, eq: (a: T, b: T) => boolean = Object.is): T {
  const store = useConsoleStore();
  // Selectors are usually inline arrows that may close over props: keep the latest one in a ref (the same pattern as
  // use-sync-external-store/with-selector) and cache per (state, selector) so getSnapshot stays stable within a render.
  const selRef = useRef(selector);
  const eqRef = useRef(eq);
  selRef.current = selector;
  eqRef.current = eq;
  const cache = useRef<{ state: UiState; sel: (s: UiState) => T; value: T } | null>(null);
  const get = useCallback(() => {
    const state = store.getState();
    const sel = selRef.current;
    const prev = cache.current;
    if (prev && prev.state === state && prev.sel === sel) return prev.value;
    const value = sel(state);
    if (prev && eqRef.current(prev.value, value)) {
      cache.current = { state, sel, value: prev.value };
      return prev.value;
    }
    cache.current = { state, sel, value };
    return value;
  }, [store]);
  return useSyncExternalStore(store.subscribe, get, get);
}
