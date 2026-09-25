/**
 * client/va/payment-watch.ts - the progress-aware wait for the payment after send_esign_and_pay_link (DESIGN §5.8
 * hold protocol steps 3–8; used by BOTH pay-tool modes). Pure logic on injected timers and a payment poller.
 *
 * - Polls GET /api/payments/[id] every PAYMENT_POLL_MS (1.5 s). A view with `toolResult` is terminal (the server
 *   builds it for succeeded / failed / expired, G0).
 * - Deadline: HOLD_DEADLINE_MS (60 s) from the SMS while the phone is still `sms-received`. While the phone is in
 *   esign, signed, checkout-loading, checkout-open, processing or simulating, the deadline extends in
 *   HOLD_EXTEND_STEP_MS (30 s) steps up to HOLD_MAX_MS (180 s) in total. At the deadline → "timeout".
 * - Reassurance at +45 s and every 45 s after, suppressed while the Polar overlay is open or processing.
 * - After a timeout the watch keeps polling (every 3 s) so a late success still reaches the session (step 8).
 */
import "client-only";

import type { PaymentView } from "@/core/contracts/api";
import type { VaPaymentPoller } from "@/core/contracts/ext/wp5b-va";
import type { PhoneState } from "@/core/contracts/services";
import { TAKEOVER_TIMING } from "@/core/contracts/takeover";

/** Phone states that extend the deadline (DESIGN §5.8 step 4). */
export const EXTENDING_PHONE_STATES: ReadonlySet<PhoneState> = new Set(["esign", "signed", "checkout-loading", "checkout-open", "processing", "simulating"]);
/** Phone states that suppress the reassurance line (the overlay is open or processing, step 5). */
export const QUIET_PHONE_STATES: ReadonlySet<PhoneState> = new Set(["checkout-open", "processing"]);

export type PaymentOutcome =
  | { kind: "terminal"; view: PaymentView; late: boolean }
  | { kind: "timeout"; atMs: number };

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(h: unknown): void;
}

export interface PaymentWatchOptions {
  paymentId: string;
  poll: VaPaymentPoller;
  now: () => number;
  timers?: Timers;
  onReassure?: () => void;
  onOutcome: (o: PaymentOutcome) => void;
  /** A failed poll (network) is ignored and retried; this sees it for logging. */
  onPollError?: (e: unknown) => void;
  timing?: Partial<typeof TAKEOVER_TIMING>;
}

const defaultTimers: Timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export class PaymentWatch {
  private readonly o: PaymentWatchOptions;
  private readonly t: typeof TAKEOVER_TIMING;
  private readonly timers: Timers;
  private smsAt = 0;
  private deadline = 0;
  private phone: PhoneState = "sms-received";
  private nextReassureAt = 0;
  private pollHandle: unknown = null;
  private tickHandle: unknown = null;
  private timedOut = false;
  private finished = false;
  private stopped = false;
  private inFlight = false;

  constructor(o: PaymentWatchOptions) {
    this.o = o;
    this.t = { ...TAKEOVER_TIMING, ...(o.timing ?? {}) } as typeof TAKEOVER_TIMING;
    this.timers = o.timers ?? defaultTimers;
  }

  get state(): "watching" | "timed_out" | "done" | "stopped" {
    return this.stopped ? "stopped" : this.finished ? "done" : this.timedOut ? "timed_out" : "watching";
  }

  get deadlineAt(): number {
    return this.deadline;
  }

  start(smsAtMs: number = this.o.now()): void {
    this.smsAt = smsAtMs;
    this.deadline = smsAtMs + this.t.HOLD_DEADLINE_MS;
    this.nextReassureAt = smsAtMs + this.t.REASSURE_EVERY_MS;
    this.schedulePoll(this.t.PAYMENT_POLL_MS);
    this.scheduleTick();
  }

  setPhoneState(s: PhoneState): void {
    this.phone = s;
  }

  stop(): void {
    this.stopped = true;
    if (this.pollHandle !== null) this.timers.clearTimeout(this.pollHandle);
    if (this.tickHandle !== null) this.timers.clearTimeout(this.tickHandle);
    this.pollHandle = this.tickHandle = null;
  }

  /** Deadline and reassurance bookkeeping; exposed for tests (normally driven by an internal 250 ms timer). */
  tick(now: number = this.o.now()): void {
    if (this.stopped || this.finished || this.timedOut) return;
    if (now >= this.deadline) {
      const total = this.deadline - this.smsAt;
      if (EXTENDING_PHONE_STATES.has(this.phone) && total < this.t.HOLD_MAX_MS) {
        this.deadline = Math.min(this.smsAt + this.t.HOLD_MAX_MS, this.deadline + this.t.HOLD_EXTEND_STEP_MS);
      } else {
        this.timedOut = true;
        this.o.onOutcome({ kind: "timeout", atMs: now });
        return;
      }
    }
    if (now >= this.nextReassureAt) {
      this.nextReassureAt = now + this.t.REASSURE_EVERY_MS;
      if (!QUIET_PHONE_STATES.has(this.phone)) this.o.onReassure?.();
    }
  }

  /** One poll; exposed for tests. */
  async pollOnce(): Promise<void> {
    if (this.stopped || this.finished || this.inFlight) return;
    this.inFlight = true;
    try {
      const view = await this.o.poll(this.o.paymentId);
      if (this.stopped || this.finished) return;
      const terminal = view.toolResult !== undefined || view.status === "succeeded" || view.status === "failed" || view.status === "expired";
      // after a client timeout only a success still matters (step 8)
      if (terminal && (!this.timedOut || view.status === "succeeded")) {
        this.finished = true;
        this.o.onOutcome({ kind: "terminal", view, late: this.timedOut });
      }
    } catch (e) {
      this.o.onPollError?.(e);
    } finally {
      this.inFlight = false;
    }
  }

  private schedulePoll(ms: number): void {
    if (this.stopped || this.finished) return;
    this.pollHandle = this.timers.setTimeout(() => {
      void this.pollOnce().finally(() => this.schedulePoll(this.timedOut ? 3000 : this.t.PAYMENT_POLL_MS));
    }, ms);
  }

  private scheduleTick(): void {
    if (this.stopped || this.finished || this.timedOut) return;
    this.tickHandle = this.timers.setTimeout(() => {
      this.tick();
      this.scheduleTick();
    }, 250);
  }
}

/** The client-built timeout result (G0: the only final result the browser builds itself). */
export const PAY_TIMEOUT_RESULT = {
  status: "timeout",
  instruction: "Tell the customer the link stays valid for 24 hours and offer to hand back to the rep.",
} as const;

/** DESIGN §5.8 reply.create texts. */
export const PAY_LINES = {
  status: "Tell the customer in one short sentence that you've texted the secure link and you'll wait while they sign and pay.",
  reassure: "Briefly reassure the customer you're still here and the link is on their phone.",
  paid: "Payment is confirmed. Call send_confirmation now.",
  latePaid: "The payment just came through. Call send_confirmation now.",
  timeout: "The payment has not come through yet. Tell the customer the link stays valid for 24 hours and offer to hand back to the rep.",
} as const;
