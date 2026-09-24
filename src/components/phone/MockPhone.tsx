"use client";

import * as React from "react";

import { Button } from "@/components/ui/button";
import { createPaymentsClient, type PaymentsClient } from "@/client/tools/payments";
import {
  autopilotAction, countdownLeftS, initialPhone, isFinalPhone, OVERLAY_STATES, phoneReducer, TEST_CARD_DIGITS, TEST_CARD_TEXT,
  type PhoneModel,
} from "@/client/tools/phone-machine";
import { openPolarEmbed, type EmbedHandle } from "@/client/tools/polar-embed";
import type { PaymentStatus } from "@/core/contracts/case";
import type { PaymentViewExt } from "@/core/contracts/ext/wp6-payments";
import type { MockPhoneProps, PhoneState } from "@/core/contracts/services";
import { cn } from "@/lib/utils";

/**
 * MockPhone (DESIGN §1.4 S6): the customer's phone in the AI half. Lock-screen SMS → thread → e-sign sheet → pay
 * sheet (Polar sandbox embed with the test card shown BEFORE the overlay, or Simulate) → done. It owns the Polar
 * overlay and closes it itself on a server result, the hold timeout, Simulate and hand-back. It never decides a
 * payment: `paid` only follows a server status (webhook, server poll or simulate).
 *
 * `readOnly` (recorded-AI bundles): no network, no buttons; the phone follows `phone.state` / `phone.sms` events.
 * WP7 mounts it (docked or floating) and wires `onState` to `VoiceAgentController.setPayingState`.
 */

export interface MockPhoneExtraProps {
  /** API base (same origin by default). */
  base?: string;
  /** Test seam. */
  client?: PaymentsClient;
  theme?: "light" | "dark";
  className?: string;
}

const PHONE_STATES: readonly PhoneState[] = [
  "idle", "sms-received", "esign", "signed", "checkout-loading", "checkout-open", "processing", "simulating", "autopilot-countdown",
  "paid", "failed", "expired", "timeout",
];
const POLL_MS = 2_500;

const usd = (cents: number | null | undefined): string => {
  if (cents === null || cents === undefined) return "…";
  return `$${Math.floor(cents / 100)}.${String(Math.abs(cents) % 100).padStart(2, "0")}`;
};

export function MockPhone(props: MockPhoneProps & MockPhoneExtraProps) {
  const { events, paymentId, takeoverToken, variant, readOnly, autopilot, onState } = props;
  const tokenRef = React.useRef(takeoverToken);
  tokenRef.current = takeoverToken;
  const client = React.useMemo(
    () => props.client ?? createPaymentsClient({ token: () => tokenRef.current, ...(props.base !== undefined ? { base: props.base } : {}) }),
    [props.client, props.base],
  );
  const [m, dispatch] = React.useReducer(phoneReducer, undefined, initialPhone);
  const [view, setView] = React.useState<PaymentViewExt | null>(null);
  const [threadOpen, setThreadOpen] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [now, setNow] = React.useState(() => Date.now());
  const embedRef = React.useRef<EmbedHandle | null>(null);
  const seen = React.useRef(0);

  // ---- events → machine (SMS, server payment statuses, hand-back) ----
  React.useEffect(() => {
    if (events.length < seen.current) {
      // A new event log (a new run): start over.
      seen.current = 0;
      dispatch({ type: "RESET" });
      setThreadOpen(false);
    }
    for (let i = seen.current; i < events.length; i++) {
      const ev = events[i]!;
      if (ev.type === "phone.sms") dispatch({ type: "SMS", text: ev.text, link: ev.link ?? null, paymentId, atMs: Date.now() });
      else if (ev.type === "payment") dispatch({ type: "SERVER", status: ev.status });
      else if (ev.type === "va.tool" && ev.name === "hand_back_to_rep" && ev.phase === "result") embedRef.current?.close();
    }
    seen.current = events.length;
  }, [events, paymentId]);

  // ---- readOnly: follow the recorded phone.state ----
  const recordedState = React.useMemo<PhoneState | null>(() => {
    if (!readOnly) return null;
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i]!;
      if (ev.type === "phone.state" && (PHONE_STATES as readonly string[]).includes(ev.state)) return ev.state as PhoneState;
    }
    return null;
  }, [events, readOnly]);
  const state: PhoneState = recordedState ?? m.state;

  // ---- report state ----
  const reported = React.useRef<PhoneState | null>(null);
  React.useEffect(() => {
    if (readOnly || reported.current === state) return;
    reported.current = state;
    onState(state);
  }, [state, readOnly, onState]);

  // ---- server view: once with extras, then polled while not final ----
  const applyView = React.useCallback((v: PaymentViewExt) => {
    setView(v);
    if (v.status === "succeeded" || v.status === "failed" || v.status === "expired") dispatch({ type: "SERVER", status: v.status });
  }, []);
  React.useEffect(() => {
    if (readOnly || !paymentId) return;
    let stop = false;
    client.get(paymentId, { extras: true }).then((v) => !stop && applyView(v), () => undefined);
    return () => {
      stop = true;
    };
  }, [paymentId, readOnly, client, applyView]);
  React.useEffect(() => {
    if (readOnly || !paymentId || isFinalPhone(m.state) || m.state === "idle") return;
    const t = setInterval(() => {
      client.get(paymentId).then(applyView, () => undefined); // 429s and blips are ignored
    }, POLL_MS);
    return () => clearInterval(t);
  }, [paymentId, readOnly, m.state, client, applyView]);

  // A pay-link SMS the page did not emit as an event (e.g. after a reload): take it from the view.
  React.useEffect(() => {
    if (!readOnly && m.state === "idle" && paymentId && view?.sms && !isFinalPhone(state)) {
      dispatch({ type: "SMS", text: view.sms, link: view.sms.match(/https?:\/\/\S+/)?.[0] ?? null, paymentId, atMs: Date.now() });
    }
  }, [view, paymentId, m.state, readOnly, state]);

  // ---- the overlay is ours to close ----
  React.useEffect(() => {
    if (!OVERLAY_STATES.has(m.state)) {
      embedRef.current?.close();
      embedRef.current = null;
    }
  }, [m.state]);
  React.useEffect(() => () => embedRef.current?.close(), []);

  // ---- autopilot countdown ----
  React.useEffect(() => {
    if (readOnly || !autopilot || (m.state !== "sms-received" && m.state !== "autopilot-countdown")) return;
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [readOnly, autopilot, m.state]);

  const simulate = React.useCallback(async () => {
    if (!paymentId) return;
    dispatch({ type: "SIMULATE_TAP", atMs: Date.now() });
    setError(null);
    try {
      await client.simulate(paymentId);
      applyView(await client.get(paymentId));
    } catch {
      dispatch({ type: "SIMULATE_FAILED" });
      setError("Simulate did not go through. Try again.");
    }
  }, [paymentId, client, applyView]);

  React.useEffect(() => {
    const a = autopilotAction(m, now, !readOnly && autopilot);
    if (a === "start") dispatch({ type: "AUTOPILOT_START", atMs: now });
    else if (a === "fire") void simulate();
  }, [m, now, readOnly, autopilot, simulate]);

  // ---- actions ----
  const touch = () => dispatch({ type: "TOUCH", atMs: Date.now() });
  const reconcile = React.useCallback(() => {
    if (paymentId) client.get(paymentId, { reconcile: true }).then(applyView, () => undefined);
  }, [paymentId, client, applyView]);

  const sign = async (typedName: string) => {
    if (!paymentId) return;
    setError(null);
    try {
      await client.esign(paymentId, typedName);
      dispatch({ type: "SIGNED", atMs: Date.now() });
    } catch {
      setError("Could not record the signature. Try again.");
    }
  };

  const pay = () => {
    // Inside the tap (a user gesture): copy the test card first, then open the embed.
    let copied = false;
    try {
      void navigator.clipboard?.writeText(TEST_CARD_DIGITS).then(() => undefined, () => undefined);
      copied = !!navigator.clipboard;
    } catch {
      copied = false;
    }
    dispatch({ type: "PAY_TAP", atMs: Date.now(), copied });
    const url = view?.embed?.url;
    if (!url) {
      dispatch({ type: "EMBED_FAILED" });
      return;
    }
    openPolarEmbed(
      url,
      {
        onConfirmed: () => {
          dispatch({ type: "EMBED_CONFIRMED" });
          reconcile();
        },
        onSuccess: () => {
          dispatch({ type: "EMBED_SUCCESS" });
          reconcile();
        },
        onClose: () => dispatch({ type: "EMBED_CLOSED" }),
      },
      { theme: props.theme ?? "light" },
    ).then(
      (h) => {
        embedRef.current = h;
        dispatch({ type: "EMBED_OPEN" });
      },
      () => dispatch({ type: "EMBED_FAILED" }),
    );
  };

  const amountCents = view?.totalAmountCents ?? view?.amountCents ?? null;
  const smsWithLink = m.sms.find((s) => s.link) ?? null;

  return (
    <section
      aria-label="Customer's phone (simulated)"
      data-phone-state={state}
      className={cn(
        "w-[300px] shrink-0 rounded-[2.2rem] border-[10px] border-neutral-900 bg-neutral-900 shadow-xl",
        variant === "floating" && "fixed bottom-4 right-4 z-40",
        props.className,
      )}
    >
      <div className="relative flex h-[560px] flex-col overflow-hidden rounded-[1.6rem] bg-background text-foreground">
        <div className="flex items-center justify-between px-5 pt-2 text-[11px] text-muted-foreground" aria-hidden>
          <span>9:41</span>
          <span className="h-4 w-16 rounded-full bg-neutral-900" />
          <span>5G ▮▮▮</span>
        </div>
        <div className="flex-1 overflow-y-auto px-3 pb-3 pt-2" aria-live="polite">
          <Screen
            state={state}
            m={m}
            view={view}
            threadOpen={threadOpen || readOnly}
            readOnly={readOnly}
            now={now}
            amountCents={amountCents}
            smsWithLink={smsWithLink}
            onOpenThread={() => {
              touch();
              setThreadOpen(true);
            }}
            onOpenLink={() => dispatch({ type: "OPEN_LINK", atMs: Date.now() })}
            onTouch={touch}
            onSign={sign}
            onPay={pay}
            onSimulate={() => void simulate()}
          />
          {error && <p className="mt-2 rounded-md bg-destructive/10 p-2 text-xs text-destructive">{error}</p>}
        </div>
        <p className="border-t px-3 py-1.5 text-center text-[10px] text-muted-foreground">Simulated phone · fictional customer · Polar sandbox</p>
      </div>
    </section>
  );
}

interface ScreenProps {
  state: PhoneState;
  m: PhoneModel;
  view: PaymentViewExt | null;
  threadOpen: boolean;
  readOnly: boolean;
  now: number;
  amountCents: number | null;
  smsWithLink: PhoneModel["sms"][number] | null;
  onOpenThread(): void;
  onOpenLink(): void;
  onTouch(): void;
  onSign(name: string): void;
  onPay(): void;
  onSimulate(): void;
}

function Screen(p: ScreenProps) {
  const { state } = p;
  if (state === "idle") return <LockScreen />;
  if (state === "sms-received" || state === "autopilot-countdown") {
    return p.threadOpen ? (
      <Thread {...p} />
    ) : (
      <LockScreen>
        <button
          type="button"
          onClick={p.onOpenThread}
          disabled={p.readOnly}
          className="w-full rounded-2xl bg-muted/80 p-3 text-left text-sm shadow-sm backdrop-blur hover:bg-muted"
        >
          <span className="block text-[11px] font-semibold uppercase text-muted-foreground">Messages · now</span>
          <span className="line-clamp-3">{p.smsWithLink?.text ?? p.m.sms.at(-1)?.text ?? "New message"}</span>
        </button>
        {state === "autopilot-countdown" && (
          <button type="button" onClick={p.onTouch} className="mt-3 w-full rounded-xl bg-amber-500/15 p-2 text-xs text-amber-700 dark:text-amber-300">
            Autopilot: simulating the payment in {countdownLeftS(p.m, p.now)} s · tap to take over
          </button>
        )}
      </LockScreen>
    );
  }
  if (state === "esign") return <EsignSheet {...p} />;
  if (state === "paid") return <Done {...p} />;
  return <PaySheet {...p} />;
}

function LockScreen({ children }: { children?: React.ReactNode }) {
  return (
    <div className="flex h-full min-h-[440px] flex-col items-center gap-4 pt-8">
      <p className="text-5xl font-light tabular-nums">9:41</p>
      <p className="text-xs text-muted-foreground">Friday</p>
      <div className="mt-6 w-full">{children ?? <p className="text-center text-xs text-muted-foreground">No new messages</p>}</div>
    </div>
  );
}

function Thread(p: ScreenProps) {
  return (
    <div className="space-y-2">
      <p className="text-center text-xs font-medium text-muted-foreground">Harborview Insurance</p>
      {p.m.sms.map((s, i) => (
        <div key={i} className="max-w-[85%] rounded-2xl rounded-bl-sm bg-muted px-3 py-2 text-sm">
          {s.link ? (
            <>
              {s.text.replace(s.link, "").trim()}{" "}
              <button type="button" onClick={p.onOpenLink} disabled={p.readOnly} className="break-all text-primary underline">
                {s.link}
              </button>
            </>
          ) : (
            s.text
          )}
        </div>
      ))}
      {p.state === "autopilot-countdown" && (
        <button type="button" onClick={p.onTouch} className="w-full rounded-xl bg-amber-500/15 p-2 text-xs text-amber-700 dark:text-amber-300">
          Autopilot: simulating the payment in {countdownLeftS(p.m, p.now)} s · tap to take over
        </button>
      )}
    </div>
  );
}

function Row({ k, v }: { k: string; v: string | null | undefined }) {
  return (
    <div className="flex justify-between gap-2 py-0.5">
      <dt className="text-muted-foreground">{k}</dt>
      <dd className="text-right font-medium">{v ?? "—"}</dd>
    </div>
  );
}

function EsignSheet(p: ScreenProps) {
  const s = p.view?.summary;
  const [agree, setAgree] = React.useState(false);
  const [name, setName] = React.useState(s?.policyholderName ?? "");
  React.useEffect(() => {
    if (s?.policyholderName && !name) setName(s.policyholderName);
  }, [s?.policyholderName, name]);
  return (
    <form
      className="space-y-3 text-sm"
      onSubmit={(e) => {
        e.preventDefault();
        if (agree && name.trim()) p.onSign(name.trim());
      }}
    >
      <h3 className="font-semibold">Review & sign</h3>
      <p className="text-xs text-muted-foreground">
        {s?.agencyName ?? "Your agency"} · policy {s?.policyNumber ?? ""}
      </p>
      <dl className="rounded-xl border p-2 text-xs">
        <Row k="Add driver" v={s?.driver} />
        <Row k="Relationship" v={s?.relation} />
        <Row k="Vehicle" v={s?.vehicle} />
        <Row k="Effective" v={s?.effectiveDate} />
        <Row k="New monthly premium" v={s?.monthlyUsd ? `$${s.monthlyUsd}` : null} />
        <Row k="Due today" v={p.amountCents !== null ? usd(p.amountCents) : s?.dueTodayUsd ? `$${s.dueTodayUsd}` : null} />
      </dl>
      <label className="flex items-start gap-2 text-xs">
        <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} disabled={p.readOnly} className="mt-0.5" />
        <span>I agree to sign electronically. I can request a paper copy.</span>
      </label>
      <label className="block text-xs">
        <span className="text-muted-foreground">Type your full name</span>
        <input
          value={name}
          maxLength={80}
          onChange={(e) => setName(e.target.value)}
          disabled={p.readOnly}
          className="mt-1 w-full rounded-md border bg-background px-2 py-1.5 text-sm"
        />
      </label>
      <Button type="submit" className="w-full" disabled={!agree || !name.trim() || p.readOnly}>
        Sign
      </Button>
    </form>
  );
}

const STATUS_COPY: Partial<Record<PhoneState, string>> = {
  "checkout-loading": "Opening the Polar sandbox checkout…",
  "checkout-open": "Complete the payment in the Polar window.",
  processing: "Waiting for Polar to confirm… we only trust the webhook",
  simulating: "Simulating the payment…",
  failed: "The payment did not go through.",
  expired: "The checkout expired.",
  timeout: "Still waiting. The link stays valid for 24 hours.",
};

function PaySheet(p: ScreenProps) {
  const v = p.view;
  const polarLive = v?.provider === "polar" && !!v.embed;
  const busy = p.state === "checkout-loading" || p.state === "checkout-open" || p.state === "processing" || p.state === "simulating";
  const canSimulate = !p.readOnly && p.state !== "simulating" && !isFinalPhone(p.state);
  const serverStatus: PaymentStatus | undefined = v?.status;
  return (
    <div className="space-y-3 text-sm">
      <h3 className="font-semibold">Pay the amount due today</h3>
      <p className="text-3xl font-semibold tabular-nums">{usd(p.amountCents)}</p>
      <p className="text-[11px] text-muted-foreground">
        {v?.provider === "polar" ? "Polar's total, tax included" : (v?.label ?? "Simulated payment")}
      </p>
      {p.m.cardShown && (
        <p className="rounded-lg bg-muted p-2 font-mono text-xs" data-testid="test-card">
          {TEST_CARD_TEXT}
          {p.m.cardCopied ? ": copied" : ""}
        </p>
      )}
      <div className="grid gap-2">
        {polarLive && !p.readOnly && (
          <Button type="button" onClick={p.onPay} disabled={busy || serverStatus === "failed"}>
            Pay with Polar sandbox (test card, about 20 s)
          </Button>
        )}
        <Button type="button" variant={polarLive ? "outline" : "default"} onClick={p.onSimulate} disabled={!canSimulate}>
          Skip: simulate payment
        </Button>
      </div>
      {p.m.hostedLinkVisible && v?.checkoutUrl && !p.readOnly && (
        <a href={v.checkoutUrl} target="_blank" rel="noopener" className="block text-xs text-primary underline">
          Open checkout in a new tab
        </a>
      )}
      {p.m.embedFailed && (
        <p className="text-xs text-muted-foreground">The embedded checkout could not open here. Use the new-tab link or Simulate.</p>
      )}
      {STATUS_COPY[p.state] && <p className="text-xs text-muted-foreground">{STATUS_COPY[p.state]}</p>}
      {v?.failureReason === "amount_mismatch" && <p className="text-xs text-destructive">Polar's total did not match the disclosed amount, so the payment was stopped.</p>}
    </div>
  );
}

function Done(p: ScreenProps) {
  const conf = p.m.sms.find((s) => /Confirmation/i.test(s.text));
  return (
    <div className="flex flex-col items-center gap-2 pt-10 text-center text-sm">
      <span className="flex size-14 items-center justify-center rounded-full bg-success/15 text-3xl text-success" aria-hidden>
        ✓
      </span>
      <p className="text-lg font-semibold">Paid {usd(p.amountCents)}</p>
      <p className="text-xs text-muted-foreground">{p.view?.label ?? "Payment received"}</p>
      {conf && <p className="mt-4 rounded-2xl bg-muted px-3 py-2 text-left text-sm">{conf.text}</p>}
    </div>
  );
}

export default MockPhone;
