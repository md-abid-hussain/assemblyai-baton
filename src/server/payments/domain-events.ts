import "server-only";

/**
 * `payment.succeeded` (SAAS §7.1, §12 WP16 row; WP16·3).
 *
 * The event is emitted **where a payment becomes verified, fail-closed** — that is, from the two transitions that
 * only the server can make: the Polar webhook (`verified_webhook`) and our own server poll of the checkout
 * (`verified_poll`). A client never reports a success in this system, so there is no third path. A simulated
 * payment (`PAYMENTS_MODE=mock`, or the Simulate fallback after a Polar outage) is also server-made and carries
 * `provider:"simulated"`, so the receiving system can tell demo money from sandbox money at a glance.
 *
 * Like `case.verified` (WP18), it is emitted **only when the run's case has an org** (SAAS §2.6: "events are not
 * back-filled"), it is idempotent on `payment.succeeded:<paymentId>`, and a failure here never fails the payment:
 * a webhook that was applied stays applied whether or not the outbox accepted the row.
 */
import { PaymentSucceededData } from "../../core/contracts/v3/events";
import { getDb, type Db } from "../db/client";
import { log } from "../log";
import { orgOfCase, runLinks } from "../qa/domain-events";
import { getDomainEvents } from "../saas/ports";
import type { PaymentRecord } from "./store";

const payLog = log.child({ component: "payment-events" });

/** How the payment's status was established → what the event says about it. */
export function verifiedByOf(p: PaymentRecord): "verified_webhook" | "verified_poll" | null {
  if (p.status !== "succeeded") return null;
  if (p.statusSource === "webhook") return "verified_webhook";
  // A server poll and the server-side Simulate are both "we decided this, not the caller".
  if (p.statusSource === "server_poll" || p.statusSource === "mock") return "verified_poll";
  return null;
}

export const providerOf = (p: PaymentRecord): "polar_sandbox" | "simulated" =>
  p.simulated || p.provider === "mock" ? "simulated" : "polar_sandbox";

export interface PaymentEventDeps {
  db?: Db;
  appUrl?: string | null;
}

/**
 * Emit `payment.succeeded` for a payment that has just reached `succeeded`. Returns false when there is nothing to
 * emit (not succeeded, no org yet, already emitted) — it never throws into the payment path.
 */
export async function emitPaymentSucceeded(p: PaymentRecord, deps: PaymentEventDeps = {}): Promise<boolean> {
  const verified_by = verifiedByOf(p);
  if (!verified_by) return false;
  try {
    const db = deps.db ?? getDb();
    const orgId = await orgOfCase(db, p.caseId);
    if (!orgId) return false;
    const cents = p.totalAmountCents ?? p.amountCents;
    const data = PaymentSucceededData.parse({
      run_id: p.takeoverId,
      payment_id: p.id,
      amount: Math.round(cents) / 100,
      currency: "USD",
      provider: providerOf(p),
      verified_by,
      links: runLinks(deps.appUrl ?? process.env.APP_URL ?? null, p.takeoverId),
    });
    const r = await getDomainEvents().emit({
      orgId, type: "payment.succeeded", data, dedupeKey: `payment.succeeded:${p.id}`,
    });
    if (r.created) payLog.info("payment.succeeded emitted", { paymentId: p.id, eventId: r.eventId });
    return r.created;
  } catch (err) {
    payLog.warn("payment.succeeded was not emitted", { paymentId: p.id, err });
    return false;
  }
}
