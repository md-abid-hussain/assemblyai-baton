import "client-only";

import type { PaymentStatus } from "../../core/contracts/case";
import type { PhoneState } from "../../core/contracts/services";
import { TAKEOVER_TIMING } from "../../core/contracts/takeover";

/**
 * The MockPhone state machine (DESIGN §1.4 S6), pure. The component feeds it user taps, embed events and server
 * payment statuses; it never decides a payment itself: only a SERVER status reaches `paid`/`failed`/`expired`.
 *
 * idle → sms-received → esign → signed → checkout-loading → checkout-open → processing → paid
 *                    ↘ autopilot-countdown → simulating → paid            signed → simulating → paid
 * any non-final → timeout (the hold deadline); timeout → paid on a late verified success.
 */

export interface PhoneSms {
  text: string;
  link: string | null;
  atMs: number;
}

export interface PhoneModel {
  state: PhoneState;
  paymentId: string | null;
  sms: PhoneSms[];
  smsAtMs: number | null;
  /** Last judge interaction with the phone (null = untouched since the pay-link SMS). */
  touchedAtMs: number | null;
  countdownEndsAtMs: number | null;
  /** "Card 4242 4242 4242 4242 · 12/34 · 123: copied" is on the sheet (shown BEFORE the overlay opens). */
  cardShown: boolean;
  cardCopied: boolean;
  /** "Open checkout in a new tab" is visible from checkout-loading onwards (never opened by a timer). */
  hostedLinkVisible: boolean;
  /** The embed could not load (blocked or timed out): the hosted link and Simulate remain. */
  embedFailed: boolean;
  /** The state before a simulate / countdown, to return to if it fails or is cancelled. */
  resumeState: PhoneState | null;
}

export type PhoneEvent =
  | { type: "SMS"; text: string; link?: string | null; paymentId?: string | null; atMs: number }
  | { type: "TOUCH"; atMs: number }
  | { type: "OPEN_LINK"; atMs: number }
  | { type: "SIGNED"; atMs: number }
  | { type: "PAY_TAP"; atMs: number; copied: boolean }
  | { type: "EMBED_OPEN" }
  | { type: "EMBED_CONFIRMED" }
  | { type: "EMBED_SUCCESS" }
  | { type: "EMBED_CLOSED" }
  | { type: "EMBED_FAILED" }
  | { type: "SIMULATE_TAP"; atMs: number }
  | { type: "SIMULATE_FAILED" }
  | { type: "AUTOPILOT_START"; atMs: number }
  | { type: "SERVER"; status: PaymentStatus }
  | { type: "RESET" };

export const TEST_CARD_TEXT = "Card 4242 4242 4242 4242 · 12/34 · 123";
export const TEST_CARD_DIGITS = "4242424242424242";

export const initialPhone = (): PhoneModel => ({
  state: "idle",
  paymentId: null,
  sms: [],
  smsAtMs: null,
  touchedAtMs: null,
  countdownEndsAtMs: null,
  cardShown: false,
  cardCopied: false,
  hostedLinkVisible: false,
  embedFailed: false,
  resumeState: null,
});

const FINAL: ReadonlySet<PhoneState> = new Set<PhoneState>(["paid", "failed", "expired"]);
export const isFinalPhone = (s: PhoneState): boolean => FINAL.has(s);
/** States in which the Polar overlay may be on screen (MockPhone must close it when leaving them). */
export const OVERLAY_STATES: ReadonlySet<PhoneState> = new Set<PhoneState>(["checkout-loading", "checkout-open", "processing"]);

export function phoneReducer(m: PhoneModel, e: PhoneEvent): PhoneModel {
  switch (e.type) {
    case "RESET":
      return initialPhone();
    case "SMS": {
      const sms = [...m.sms, { text: e.text, link: e.link ?? null, atMs: e.atMs }];
      // The pay-link SMS (it carries a link) starts the flow; later texts (the confirmation) only append.
      if (e.link && (m.state === "idle" || m.paymentId !== (e.paymentId ?? m.paymentId))) {
        return { ...initialPhone(), sms, state: "sms-received", paymentId: e.paymentId ?? m.paymentId, smsAtMs: e.atMs };
      }
      return { ...m, sms };
    }
    case "TOUCH":
      if (m.state === "autopilot-countdown") return { ...m, state: m.resumeState ?? "sms-received", countdownEndsAtMs: null, resumeState: null, touchedAtMs: e.atMs };
      return { ...m, touchedAtMs: e.atMs };
    case "OPEN_LINK":
      if (m.state === "sms-received" || m.state === "autopilot-countdown") return { ...m, state: "esign", touchedAtMs: e.atMs, countdownEndsAtMs: null, resumeState: null };
      return m;
    case "SIGNED":
      return m.state === "esign" ? { ...m, state: "signed", touchedAtMs: e.atMs } : m;
    case "PAY_TAP":
      if (m.state !== "signed") return m;
      return { ...m, state: "checkout-loading", touchedAtMs: e.atMs, cardShown: true, cardCopied: e.copied, hostedLinkVisible: true, embedFailed: false };
    case "EMBED_OPEN":
      return m.state === "checkout-loading" ? { ...m, state: "checkout-open" } : m;
    case "EMBED_CONFIRMED":
    case "EMBED_SUCCESS":
      return m.state === "checkout-open" || m.state === "checkout-loading" ? { ...m, state: "processing" } : m;
    case "EMBED_CLOSED":
      // The judge closed the overlay before paying: back to the pay sheet (hosted link + Simulate stay).
      return m.state === "checkout-open" || m.state === "checkout-loading" ? { ...m, state: "signed" } : m;
    case "EMBED_FAILED":
      return OVERLAY_STATES.has(m.state) ? { ...m, state: "signed", embedFailed: true, hostedLinkVisible: true } : { ...m, embedFailed: true };
    case "SIMULATE_TAP":
      if (isFinalPhone(m.state) || m.state === "simulating" || m.state === "idle") return m;
      return { ...m, state: "simulating", resumeState: m.state === "autopilot-countdown" ? "sms-received" : m.state, touchedAtMs: e.atMs, countdownEndsAtMs: null };
    case "SIMULATE_FAILED":
      return m.state === "simulating" ? { ...m, state: m.resumeState ?? "signed", resumeState: null } : m;
    case "AUTOPILOT_START":
      return m.state === "sms-received" ? { ...m, state: "autopilot-countdown", resumeState: "sms-received", countdownEndsAtMs: e.atMs + TAKEOVER_TIMING.AUTOPILOT_COUNTDOWN_MS } : m;
    case "SERVER":
      switch (e.status) {
        case "succeeded":
          return { ...m, state: "paid", countdownEndsAtMs: null, resumeState: null };
        case "failed":
          return m.state === "paid" ? m : { ...m, state: "failed", countdownEndsAtMs: null };
        case "expired":
          return m.state === "paid" ? m : { ...m, state: "expired", countdownEndsAtMs: null };
        case "timeout":
          return isFinalPhone(m.state) || m.state === "idle" ? m : { ...m, state: "timeout", countdownEndsAtMs: null };
        default:
          return m;
      }
  }
}

/**
 * Autopilot (DESIGN §5.8 step 6): the phone untouched 15 s after the SMS → a visible 10 s countdown → simulate.
 * Returns what the component should dispatch now.
 */
export function autopilotAction(m: PhoneModel, nowMs: number, autopilot: boolean): "start" | "fire" | null {
  if (!autopilot) return null;
  if (m.state === "sms-received" && m.touchedAtMs === null && m.smsAtMs !== null && nowMs - m.smsAtMs >= TAKEOVER_TIMING.AUTOPILOT_IDLE_MS) return "start";
  if (m.state === "autopilot-countdown" && m.countdownEndsAtMs !== null && nowMs >= m.countdownEndsAtMs) return "fire";
  return null;
}

/** Seconds left on the autopilot countdown (for the visible counter). */
export const countdownLeftS = (m: PhoneModel, nowMs: number): number =>
  m.countdownEndsAtMs === null ? 0 : Math.max(0, Math.ceil((m.countdownEndsAtMs - nowMs) / 1000));
