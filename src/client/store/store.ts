/**
 * client/store/store.ts - `BatonStore` (TASKS §2): an EventSink-compatible external store for the call console.
 *
 * `dispatch(BatonEvent)` is the contract; `act(UiAction)` carries the orchestrator's non-event facts; `apply()`
 * takes either (fixture logs). Listeners are notified synchronously; React reads it via `useSyncExternalStore`.
 * The raw event log is kept (bounded) so MockPhone (`MockPhoneProps.events`) and the recorder can read it.
 */
import "client-only";

import type { BatonEvent } from "@/core/contracts/events";
import type { UiAction, UiLogEntry } from "@/core/contracts/ext/wp7-ui";
import type { BatonStore, EventSink } from "@/core/contracts/services";

import { initialUiState, reduceEntry, type UiState } from "./reduce";

export interface ConsoleStore extends BatonStore, EventSink {
  getState(): UiState;
  act(a: UiAction): void;
  apply(e: UiLogEntry): void;
  /** Replace the whole state (the fixture player seeks by folding the log). */
  reset(s?: UiState): void;
  /** The BatonEvents dispatched so far (bounded ring; newest last). */
  events(): readonly BatonEvent[];
  /**
   * The phone's events only (`phone.sms`, `phone.state`, `payment`, `va.tool` results of `hand_back_to_rep`): the
   * MockPhone's `events` prop. A separate, never-trimmed list with a new identity per phone event, so the phone's
   * "seen" index never slides with the bounded ring above (a 5-minute call easily exceeds it).
   */
  phoneEvents(): BatonEvent[];
}

/** The events WP6's MockPhone reads (docs/notes/requests/wp6-to-wp7.md). */
export const isPhoneEvent = (ev: BatonEvent): boolean =>
  ev.type === "phone.sms" || ev.type === "phone.state" || ev.type === "payment" || (ev.type === "va.tool" && ev.name === "hand_back_to_rep" && ev.phase === "result");

const MAX_EVENTS = 5000;

export function createConsoleStore(initial: UiState = initialUiState()): ConsoleStore {
  let state = initial;
  let log: BatonEvent[] = [];
  let phoneLog: BatonEvent[] = [];
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const l of [...listeners]) l();
  };
  const set = (next: UiState) => {
    if (next === state) return;
    state = next;
    notify();
  };
  const store: ConsoleStore = {
    getState: () => state,
    subscribe(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    dispatch(ev) {
      log.push(ev);
      if (log.length > MAX_EVENTS) log = log.slice(log.length - MAX_EVENTS);
      if (isPhoneEvent(ev)) phoneLog = [...phoneLog, ev];
      set(reduceEntry(state, ev));
    },
    emit(ev) {
      store.dispatch(ev);
    },
    act(a) {
      set(reduceEntry(state, a));
    },
    apply(e) {
      if (e.type.startsWith("ui.")) store.act(e as UiAction);
      else store.dispatch(e as BatonEvent);
    },
    reset(s = initialUiState()) {
      log = [];
      phoneLog = [];
      state = s;
      notify();
    },
    events: () => log,
    phoneEvents: () => phoneLog,
  };
  return store;
}
