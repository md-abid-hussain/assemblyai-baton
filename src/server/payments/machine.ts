import "server-only";

import type { PaymentStatus } from "../../core/contracts/case";

/**
 * The server payment state machine (DESIGN §5.12), forward-only and fail-closed:
 *
 * ```
 * created → open → confirmed → succeeded
 * open|confirmed → failed | expired                 (failed includes failure_reason=amount_mismatch)
 * created|open|confirmed|failed|expired|timeout → succeeded(simulated, source mock)   (only via POST /simulate)
 * any non-terminal → timeout                         (only the hold handler; a later webhook may still set succeeded)
 * ```
 *
 * `succeeded` is only ever set by a verified webhook, a server GET to Polar, mock mode, or simulate. A client's
 * "success" never flips a status (there is no route that accepts one). Every write is a conditional UPDATE whose
 * WHERE clause is `status = ANY(allowedFrom(to, via))`, so two racing writers cannot move a payment backwards.
 */

export type TransitionVia =
  /** Checkout created (Polar returned it, or the mock provider). */
  | "create"
  /** A verified Polar webhook. */
  | "webhook"
  /** Our server GET to Polar (poll or reconcile). */
  | "server_poll"
  /** Mock provider's own resolution (PAYMENTS_MODE=mock, "Pay" in the mock sheet is simulate). */
  | "mock"
  /** POST /api/payments/[id]/simulate. */
  | "simulate"
  /** POST /api/payments/[id]/timeout (the hold handler's deadline). */
  | "timeout"
  /** The amount check failed (create, webhook or poll): `failed` + `failure_reason=amount_mismatch`. */
  | "amount_mismatch";

const NON_TERMINAL: readonly PaymentStatus[] = ["none", "created", "open", "confirmed"];

/** Statuses a payment may move FROM to reach `to` via `via`. Empty = never allowed. */
export function allowedFrom(to: PaymentStatus, via: TransitionVia): readonly PaymentStatus[] {
  switch (via) {
    case "create":
      return to === "open" ? ["none", "created"] : to === "created" ? ["none"] : [];
    case "webhook":
    case "server_poll":
      switch (to) {
        case "open":
          return ["none", "created"];
        case "confirmed":
          return ["created", "open"];
        // `timeout` never blocks a later verified success (the late-success path, §5.8 step 8).
        case "succeeded":
          return ["created", "open", "confirmed", "timeout"];
        case "failed":
        case "expired":
          return ["created", "open", "confirmed", "timeout"];
        default:
          return [];
      }
    case "mock":
      return to === "succeeded" ? ["created", "open", "confirmed", "timeout"] : [];
    case "simulate":
      return to === "succeeded" ? ["none", "created", "open", "confirmed", "failed", "expired", "timeout"] : [];
    case "timeout":
      return to === "timeout" ? NON_TERMINAL : [];
    case "amount_mismatch":
      return to === "failed" ? ["none", "created", "open", "confirmed", "timeout"] : [];
  }
}

export function canTransition(from: PaymentStatus, to: PaymentStatus, via: TransitionVia): boolean {
  return allowedFrom(to, via).includes(from);
}

/** Map a Polar checkout status to ours (Polar: open | expired | confirmed | succeeded | failed). */
export function fromPolarCheckoutStatus(s: string): PaymentStatus | null {
  switch (s) {
    case "open":
      return "open";
    case "confirmed":
      return "confirmed";
    case "succeeded":
      return "succeeded";
    case "failed":
      return "failed";
    case "expired":
      return "expired";
    default:
      return null;
  }
}

export const isTerminal = (s: PaymentStatus): boolean => s === "succeeded" || s === "failed" || s === "expired";

/** "$23.40" from cents (tool results and the phone; never a local amount for a Polar payment, §5.8). */
export function formatUsd(cents: number): string {
  const neg = cents < 0;
  const abs = Math.abs(Math.round(cents));
  return `${neg ? "-" : ""}$${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

/** Dollars as a normalized string ("23.40") → integer cents. Throws on a non-number. */
export function usdToCents(usd: string | number): number {
  const n = typeof usd === "number" ? usd : Number(usd);
  if (!Number.isFinite(n)) throw new Error(`not an amount: ${String(usd)}`);
  return Math.round(n * 100);
}
