import "client-only";

import type { PhoneState } from "../../core/contracts/services";
import { PaymentViewExtSchema, type AwaitPaymentOptions, type PaymentResolution, type PaymentViewExt } from "../../core/contracts/ext/wp6-payments";
import { TAKEOVER_TIMING } from "../../core/contracts/takeover";

/**
 * Browser access to the payment routes (#15–#17 + …/timeout) and `awaitPaymentResolution()`, the hold protocol's
 * wait (DESIGN §5.8 steps 3, 4 and 7) as one promise. A client never reports success: it only asks the server
 * (`reconcile=1` makes the server GET Polar itself).
 */

export const PAY_TIMEOUT_INSTRUCTION = "Tell the customer the link stays valid for 24 hours and offer to hand back to the rep.";

export class PaymentHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(`payment request failed: ${status} ${code}`);
    this.name = "PaymentHttpError";
  }
}

export interface PaymentsClient {
  get(id: string, opts?: { reconcile?: boolean; extras?: boolean }): Promise<PaymentViewExt>;
  esign(id: string, typedName: string): Promise<{ ok: true; signedAt: string }>;
  simulate(id: string): Promise<{ ok: true }>;
  timeout(id: string): Promise<{ ok: true; status: string }>;
}

export function createPaymentsClient(o: { token: () => string; fetch?: typeof fetch; base?: string }): PaymentsClient {
  const f = o.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const base = o.base ?? "";
  async function call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const res = await f(`${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${o.token()}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) {
      let code = `HTTP_${res.status}`;
      try {
        code = ((await res.json()) as { error?: { code?: string } }).error?.code ?? code;
      } catch {
        /* keep */
      }
      throw new PaymentHttpError(res.status, code);
    }
    return (await res.json()) as T;
  }
  const p = (id: string) => `/api/payments/${encodeURIComponent(id)}`;
  return {
    async get(id, opts = {}) {
      const q = [opts.reconcile ? "reconcile=1" : "", opts.extras ? "extras=1" : ""].filter(Boolean).join("&");
      return PaymentViewExtSchema.parse(await call("GET", `${p(id)}${q ? `?${q}` : ""}`));
    },
    esign: (id, typedName) => call("POST", `${p(id)}/esign`, { consent: true, typedName }),
    simulate: (id) => call("POST", `${p(id)}/simulate`),
    timeout: (id) => call("POST", `${p(id)}/timeout`),
  };
}

// ------------------------------------------------------------------------------------------ hold deadline (pure)

/** Phone states that extend the hold (DESIGN §5.8 step 4). */
export const HOLD_EXTEND_STATES: ReadonlySet<PhoneState> = new Set<PhoneState>([
  "esign", "signed", "checkout-loading", "checkout-open", "processing", "simulating",
]);

/**
 * §5.8 step 4: 60 s from the SMS while the phone is `sms-received`; while the judge is active on the phone the
 * deadline moves out in 30 s steps (whenever it is within one step of passing), up to 180 s after the SMS.
 */
export function nextHoldDeadline(i: { smsAtMs: number; deadlineMs: number; nowMs: number; phone: PhoneState }): number {
  const cap = i.smsAtMs + TAKEOVER_TIMING.HOLD_MAX_MS;
  let d = i.deadlineMs;
  if (HOLD_EXTEND_STATES.has(i.phone)) while (d - i.nowMs < TAKEOVER_TIMING.HOLD_EXTEND_STEP_MS && d < cap) d = Math.min(cap, d + TAKEOVER_TIMING.HOLD_EXTEND_STEP_MS);
  return d;
}

/** §5.8 step 5: reassure at +45 s and every 45 s, never while the Polar overlay is open or processing. */
export function reassureDue(i: { smsAtMs: number; nowMs: number; sent: number; phone: PhoneState }): boolean {
  if (i.phone === "checkout-open" || i.phone === "processing") return false;
  return i.nowMs - i.smsAtMs >= (i.sent + 1) * TAKEOVER_TIMING.REASSURE_EVERY_MS;
}

/**
 * Wait for the payment to resolve: poll #15 every 1.5 s (429s and network errors ignored), resolve with the
 * server-built `toolResult` once terminal, or with a client-built `timeout` at the progress-aware deadline (the
 * server is told via POST …/timeout, best-effort; a later verified success still lands, §5.8 step 8).
 */
export async function awaitPaymentResolution(client: Pick<PaymentsClient, "get" | "timeout">, o: AwaitPaymentOptions & { pollMs?: number; sleep?: (ms: number) => Promise<void> }): Promise<PaymentResolution> {
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const pollMs = o.pollMs ?? TAKEOVER_TIMING.PAYMENT_POLL_MS;
  let deadline = o.smsAtMs + TAKEOVER_TIMING.HOLD_DEADLINE_MS;
  let last: PaymentViewExt | null = null;
  for (;;) {
    if (o.signal?.aborted) throw new DOMException("aborted", "AbortError");
    try {
      const v = await client.get(o.paymentId);
      last = v;
      o.onView?.(v);
      if (v.toolResult) return { result: v.toolResult, view: v, timedOut: false };
    } catch (e) {
      // 429, 5xx and network errors: ignored, keep polling. Auth or a vanished payment: give up.
      if (e instanceof PaymentHttpError && (e.status === 401 || e.status === 403 || e.status === 404)) throw e;
    }
    deadline = nextHoldDeadline({ smsAtMs: o.smsAtMs, deadlineMs: deadline, nowMs: now(), phone: o.phoneState() });
    if (now() >= deadline) {
      await client.timeout(o.paymentId).catch(() => undefined);
      return { result: { status: "timeout", instruction: PAY_TIMEOUT_INSTRUCTION }, view: last, timedOut: true };
    }
    await sleep(pollMs);
  }
}
