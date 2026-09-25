"use client";
/**
 * The MockPhone container (DESIGN §1.4 S2 right column, S6): docked in the right column on ≥1600 px, and floating
 * bottom-right from `phone.sms` onwards on anything narrower, so it is never below the fold on a 1366×768 laptop.
 * WP6's MockPhone (`src/components/phone/MockPhone.tsx`) is mounted through `ConsoleEnv.renderPhone` (live runs and
 * the /dev/ui `phone=wp6` harness): it brings its own frame, gets the phone's events from `store.phoneEvents()`, and
 * its `onState` goes to `actions.setPhoneState` (store + the VA's progress-aware hold). Without `renderPhone` (fixture
 * logs, recorded runs) a read-only preview renders the same events (phone.sms, phone.state, payment).
 */
import { BatteryFullIcon, CheckCircle2Icon, ChevronDownIcon, CreditCardIcon, FileSignatureIcon, Loader2Icon, MessageSquareIcon, SignalIcon, SmartphoneIcon } from "lucide-react";
import { useCallback, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";

import { useBaton, useConsoleStore } from "@/client/store/hooks";
import { formatUsd, names } from "@/client/store/selectors";
import type { PhoneState } from "@/core/contracts/services";
import { cn } from "@/lib/utils";

import { useConsoleEnv } from "../common/console-context";

const STEP_COPY: Record<string, { title: string; body: string; Icon: typeof CheckCircle2Icon; tone: "ai" | "ok" | "warn" }> = {
  "sms-received": { title: "Your turn: tap the text", body: "Review & sign, then pay today's amount.", Icon: MessageSquareIcon, tone: "ai" },
  esign: { title: "E-sign", body: "I agree to sign electronically. I can request a paper copy.", Icon: FileSignatureIcon, tone: "ai" },
  signed: { title: "Signed", body: "Opening the payment sheet…", Icon: CheckCircle2Icon, tone: "ok" },
  "checkout-loading": { title: "Polar sandbox checkout", body: "Card 4242 4242 4242 4242 · 12/34 · 123: copied", Icon: CreditCardIcon, tone: "ai" },
  "checkout-open": { title: "Polar sandbox checkout", body: "Card 4242 4242 4242 4242 · 12/34 · 123: copied", Icon: CreditCardIcon, tone: "ai" },
  processing: { title: "Waiting for Polar to confirm…", body: "We only trust the webhook.", Icon: Loader2Icon, tone: "ai" },
  simulating: { title: "Simulating payment", body: "The server marks this payment as simulated (mock mode).", Icon: Loader2Icon, tone: "warn" },
  "autopilot-countdown": { title: "Autopilot will simulate the payment", body: "…or pay with the test card.", Icon: Loader2Icon, tone: "warn" },
  paid: { title: "Paid", body: "Verified by Polar webhook.", Icon: CheckCircle2Icon, tone: "ok" },
  failed: { title: "Payment failed", body: "Skip: simulate payment is still available.", Icon: CreditCardIcon, tone: "warn" },
  expired: { title: "Checkout expired", body: "Skip: simulate payment is still available.", Icon: CreditCardIcon, tone: "warn" },
  timeout: { title: "Still waiting", body: "A payment that lands late still confirms.", Icon: CreditCardIcon, tone: "warn" },
};

function PhonePreview() {
  const phone = useBaton((s) => s.phone);
  const pay = useBaton((s) => s.payment);
  const cs = useBaton((s) => s.caseState);
  const who = useBaton((s) => names(s));
  const agency = useBaton((s) => s.context?.policy.agencyName ?? "Your agency");
  const step = STEP_COPY[phone.state];
  const amount = cs?.payment?.totalAmountCents ?? cs?.payment?.amountCents ?? null;
  const simulated = cs?.payment?.simulated || pay?.source === "mock";
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between px-5 pt-2 text-[10px] font-semibold text-(--bt-ink)" aria-hidden="true">
        <span className="bt-mono">9:41</span>
        <span className="flex items-center gap-1">
          <SignalIcon className="size-3" />
          <BatteryFullIcon className="size-3.5" />
        </span>
      </div>
      <div className="border-b border-(--bt-line) px-4 pt-1 pb-2 text-center">
        <div className="mx-auto flex size-8 items-center justify-center rounded-full bg-(--rep-bg) text-xs font-bold text-(--rep-fg)" aria-hidden="true">
          {agency.slice(0, 1)}
        </div>
        <div className="mt-0.5 text-[11px] font-semibold">{agency}</div>
      </div>
      <ol className="bt-scroll flex-1 space-y-2 px-3 py-3" aria-label={`Text messages on ${who.customer}'s phone`}>
        {phone.sms.map((m) => (
          <li key={m.t} className="max-w-[88%] rounded-2xl rounded-bl-md bg-(--bt-panel-2) px-3 py-2 text-[12px] leading-snug shadow-[0_1px_0_var(--bt-line)]">
            {m.text.split(/(https?:\/\/\S+)/).map((part, i) =>
              /^https?:\/\//.test(part) ? (
                <span key={i} className="break-all text-(--rep-fg) underline">
                  {part}
                </span>
              ) : (
                <span key={i}>{part}</span>
              ),
            )}
          </li>
        ))}
        {!phone.sms.length ? <li className="pt-10 text-center text-[11px] text-(--bt-muted)">No messages yet. The AI texts the e-sign and pay link in the Pay stage.</li> : null}
      </ol>
      {step ? (
        <div className={cn("m-2 rounded-2xl border p-3", step.tone === "ok" ? "border-(--verified)/40 bg-(--verified-bg)" : step.tone === "warn" ? "border-(--pending)/50 bg-(--pending-bg)" : "border-(--ai)/35 bg-(--ai-bg)")} role="status">
          <div className={cn("flex items-center gap-1.5 text-[13px] font-semibold", step.tone === "ok" ? "text-(--verified-fg)" : step.tone === "warn" ? "text-(--pending-fg)" : "text-(--ai-fg)")}>
            <step.Icon className={cn("size-4", step.Icon === Loader2Icon && "animate-spin")} aria-hidden="true" />
            {phone.state === "paid" && simulated ? "Simulated" : step.title}
          </div>
          <p className="mt-0.5 text-[11.5px] text-(--bt-ink)">{phone.state === "paid" && simulated ? "Simulated payment (mock mode)." : step.body}</p>
          {phone.state === "esign" && cs ? (
            <dl className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-2 text-[11px]">
              <dt className="text-(--bt-muted)">Driver</dt>
              <dd>{cs.fields.driver_full_name.display ?? "—"}</dd>
              <dt className="text-(--bt-muted)">Vehicle</dt>
              <dd>{cs.fields.vehicle_assignment.display ?? "—"}</dd>
              <dt className="text-(--bt-muted)">Effective</dt>
              <dd>{cs.fields.effective_date.display ?? "—"}</dd>
              <dt className="text-(--bt-muted)">New premium</dt>
              <dd>{cs.fields.premium_new_monthly_usd.display ?? "—"}</dd>
            </dl>
          ) : null}
          {amount !== null && (phone.state.startsWith("checkout") || phone.state === "processing" || phone.state === "paid") ? (
            <div className="bt-display mt-1 text-lg font-bold">{formatUsd(amount)} <span className="text-[11px] font-normal text-(--bt-muted)">due today, tax incl.</span></div>
          ) : null}
        </div>
      ) : null}
      <p className="px-3 pb-2 text-center text-[10px] text-(--bt-faint)">Read-only preview of {who.customer}&apos;s phone</p>
    </div>
  );
}

function PhoneFrame({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("relative flex h-full flex-col overflow-hidden rounded-[30px] border-[6px] border-(--bt-ink) bg-(--bt-panel) shadow-2xl", className)}>
      <div aria-hidden="true" className="absolute top-1 left-1/2 z-10 h-4 w-20 -translate-x-1/2 rounded-full bg-(--bt-ink)" />
      <div className="flex min-h-0 flex-1 flex-col pt-3">{children}</div>
    </div>
  );
}

/** WP6's MockPhone through `ConsoleEnv.renderPhone`, or null when the page has none (the preview renders instead). */
function useMountedPhone(variant: "docked" | "floating"): ReactNode | null {
  const env = useConsoleEnv();
  const store = useConsoleStore();
  const events = useSyncExternalStore(store.subscribe, store.phoneEvents, store.phoneEvents);
  const autopilot = useBaton((s) => s.autopilot);
  const readOnly = useBaton((s) => s.mode === "recorded_ai" || s.plan?.aiHalf === "recorded");
  const { actions } = env;
  const onState = useCallback((st: PhoneState) => actions.setPhoneState(st), [actions]);
  if (!env.renderPhone) return null;
  const auth = env.phoneAuth?.() ?? { paymentId: null, takeoverToken: "" };
  return env.renderPhone({
    events,
    paymentId: auth.paymentId,
    takeoverToken: auth.takeoverToken,
    variant,
    readOnly,
    autopilot,
    onState,
    // The console positions the floating phone itself (with the "Your turn" pill and the minimise button).
    className: variant === "floating" ? "static shadow-2xl" : "shadow-lg",
  });
}

/** Docked variant (right column ≥1600 px, the mobile Phone tab). */
export function DockedPhone({ className }: { className?: string }) {
  const mounted = useMountedPhone("docked");
  if (mounted) return <div className="flex justify-center">{mounted}</div>;
  return (
    <div className={cn("mx-auto h-[520px] w-[280px]", className)}>
      <PhoneFrame>
        <PhonePreview />
      </PhoneFrame>
    </div>
  );
}

/** Floating overlay (bottom-right) from phone.sms onwards on screens narrower than 1600 px. */
export function FloatingPhone() {
  const mounted = useMountedPhone("floating");
  const hasSms = useBaton((s) => s.phone.sms.length > 0);
  const state = useBaton((s) => s.phone.state);
  const customer = useBaton((s) => names(s).customer);
  const [open, setOpen] = useState(true);
  const yourTurn = state === "sms-received";
  const terminal = state === "paid" || state === "failed" || state === "expired";
  const done = useBaton((s) => s.flowPhase === "completed" || s.flowPhase === "handed-back");
  useEffect(() => {
    if (yourTurn) setOpen(true);
  }, [yourTurn]);
  useEffect(() => {
    // The pass is over and the QA card opens: the phone steps aside at once.
    if (done) setOpen(false);
  }, [done]);
  useEffect(() => {
    // Once the payment is settled the overlay steps aside (it stays one tap away as a pill).
    if (!terminal) return;
    const id = setTimeout(() => setOpen(false), 5000);
    return () => clearTimeout(id);
  }, [terminal]);
  if (!hasSms) return null;
  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={cn("bt-rise fixed right-4 bottom-4 z-40 inline-flex items-center gap-2 rounded-full bg-(--bt-ink) px-4 py-2.5 text-sm font-semibold text-(--bt-panel) shadow-xl", yourTurn && "bt-attention")}
      >
        <SmartphoneIcon className="size-4" aria-hidden="true" /> {customer}&apos;s phone{yourTurn ? " · your turn" : ""}
      </button>
    );
  }
  const header = (
    <div className="mb-1.5 flex w-full items-center justify-between gap-2">
      {yourTurn ? (
        <span className="bt-attention rounded-full bg-(--ai) px-3 py-1 text-xs font-bold text-(--bt-accent-ink)">Your turn: tap the text</span>
      ) : (
        <span className="rounded-full bg-(--bt-panel) px-3 py-1 text-xs font-semibold shadow">{customer}&apos;s phone</span>
      )}
      <button type="button" onClick={() => setOpen(false)} className="inline-flex size-7 items-center justify-center rounded-full bg-(--bt-panel) shadow" aria-label="Minimise the phone">
        <ChevronDownIcon className="size-4" aria-hidden="true" />
      </button>
    </div>
  );
  if (mounted) {
    return (
      <aside aria-label={`${customer}'s phone`} className="bt-rise fixed right-4 bottom-4 z-40 flex flex-col items-end">
        {header}
        <div className={cn("bt-phone-float rounded-[2.2rem]", yourTurn && "bt-attention")}>{mounted}</div>
      </aside>
    );
  }
  return (
    <aside aria-label={`${customer}'s phone`} className="bt-rise fixed right-4 bottom-4 z-40 flex h-[min(500px,calc(100dvh-18rem))] min-h-[360px] w-[260px] flex-col">
      {header}
      <PhoneFrame className={cn("min-h-0 flex-1", yourTurn && "bt-attention")}>
        <PhonePreview />
      </PhoneFrame>
    </aside>
  );
}
