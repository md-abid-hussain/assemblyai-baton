"use client";
/**
 * client/studio/use-source-store.ts - React bindings for the source store.
 *
 * The store itself is framework-free (`./source-store.ts`) so it can be unit-tested without a DOM; this file is the
 * only place that knows about React. `useSource(selector)` re-renders a component only when its slice changes, which
 * matters because a keystroke in Monaco updates `text` 60 times a second and the Preview panel must not re-render
 * the whole tab tree with it.
 */
import "client-only";

import { createContext, createElement, useContext, type ReactNode } from "react";
import { useStore } from "zustand";

import type { SourceActions, SourceState, SourceStore } from "./source-store";

const Ctx = createContext<SourceStore | null>(null);

export function SourceStoreProvider({ store, children }: { store: SourceStore; children: ReactNode }) {
  return createElement(Ctx.Provider, { value: store }, children);
}

export function useSourceStore(): SourceStore {
  const s = useContext(Ctx);
  if (!s) throw new Error("useSourceStore: no SourceStoreProvider above this component");
  return s;
}

export function useSource<T>(selector: (s: SourceState & SourceActions) => T): T {
  return useStore(useSourceStore(), selector);
}

/** The actions, which never change identity, for handlers that do not need to re-render on state. */
export function useSourceActions(): SourceActions {
  return useSourceStore().getState();
}
