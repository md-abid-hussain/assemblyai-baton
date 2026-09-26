/**
 * The QA summary and the payment card on `/app/runs/[id]` (SAAS §6.2). WP20·1.
 *
 * Read-only twins of WP7's live cards. Every number is labelled with **how much it is worth**: a provisional
 * QA result is the console counting its own work, a verified one is the verifier re-reading the recording, and
 * the page never lets the two share a heading.
 */
import type { QaResult } from "@/core/contracts/events";
import { formatUtcDateTime, type PaymentSummaryView } from "@/core/contracts/ext/wp20-app";
import { cn } from "@/lib/utils";

import { Field, Note } from "../app-shell/bits";
import { PaymentBadge, QaBadge } from "./badges";

const ms = (v: number | null) => (v === null ? "—" : `${Math.round(v)} ms`);

const PAYMENT_QA: Record<QaResult["payment"], string> = {
  verified_webhook: "Confirmed by the provider's webhook",
  verified_poll: "Confirmed by polling the provider",
  simulated: "Simulated (no money moved)",
  unpaid: "Not paid",
};

export function QaSummary({
  qa,
  status,
  className,
}: {
  qa: QaResult | null;
  status: "verified" | "provisional" | "pending" | "none";
  className?: string;
}) {
  return (
    <div className={cn("bg-card rounded-xl border p-4", className)}>
      <div className="flex flex-wrap items-center justify-between gap-2 pb-1">
        <h3 className="text-sm font-semibold">Quality</h3>
        <QaBadge status={status} />
      </div>

      {!qa ? (
        <Note className="pt-1">
          {status === "pending"
            ? "Verification is still running. The numbers appear here when it finishes."
            : "This run produced no QA result."}
        </Note>
      ) : (
        <>
          <dl className="divide-y">
            <Field label="AI time on the call">
              {qa.aiSeconds >= 60
                ? `${Math.floor(qa.aiSeconds / 60)}m ${Math.round(qa.aiSeconds % 60)}s`
                : `${Math.round(qa.aiSeconds)}s`}
            </Field>
            <Field label="Facts re-asked">{qa.reAsked}</Field>
            <Field label="Facts newly asked">{qa.newlyAsked}</Field>
            <Field label="Pending facts confirmed">{qa.pendingConfirmed}</Field>
            <Field label="Verified facts re-confirmed">{qa.verifiedReconfirmed}</Field>
            <Field label="Click to first audible word">{ms(qa.clickToFirstAudibleMs)}</Field>
            <Field label="Dead air after the rep">{ms(qa.deadAirAfterRepMs)}</Field>
            <Field label="Turn latency (p50)">{ms(qa.turnLatencyP50Ms)}</Field>
            <Field label="Handed back to a human">{qa.handedBack ? "Yes" : "No"}</Field>
            <Field label="Payment">{PAYMENT_QA[qa.payment]}</Field>
          </dl>
          {qa.adviceFlags > 0 ? (
            <p className="text-destructive pt-2 text-xs">
              {qa.adviceFlags} agent {qa.adviceFlags === 1 ? "sentence" : "sentences"} matched the advice lexicon
              outside a disclosure. The target is zero.
            </p>
          ) : (
            <Note className="pt-2">No agent sentence matched the advice lexicon outside a disclosure.</Note>
          )}
          <Note className="pt-1">
            {status === "verified"
              ? "Re-read from the recording by the verifier."
              : "Counted by the console during the call; the verifier has not confirmed it yet."}
          </Note>
        </>
      )}
    </div>
  );
}

export function PaymentCard({ payment, className }: { payment: PaymentSummaryView | null; className?: string }) {
  if (!payment) return null;
  const money = (cents: number | null) => (cents === null ? "—" : `$${(cents / 100).toFixed(2)}`);
  return (
    <div className={cn("bg-card rounded-xl border p-4", className)}>
      <div className="flex flex-wrap items-center justify-between gap-2 pb-1">
        <h3 className="text-sm font-semibold">Payment</h3>
        <PaymentBadge status={payment.status} />
      </div>
      <dl className="divide-y">
        <Field label="Disclosed amount">{money(payment.amountCents)}</Field>
        {payment.totalAmountCents !== null && payment.totalAmountCents !== payment.amountCents ? (
          <Field label="Provider total">{money(payment.totalAmountCents)}</Field>
        ) : null}
        <Field label="Provider">
          <span className="capitalize">{payment.provider}</span>
          {payment.simulated ? <span className="text-muted-foreground"> · simulated</span> : null}
        </Field>
        {payment.statusSource ? (
          <Field label="Confirmed by">{payment.statusSource.replace(/_/g, " ")}</Field>
        ) : null}
        <Field label="Updated">{formatUtcDateTime(payment.updatedAt)}</Field>
      </dl>
      {payment.failureReason ? (
        <p className="text-destructive pt-2 text-xs">Failed: {payment.failureReason.replace(/_/g, " ")}</p>
      ) : null}
    </div>
  );
}
