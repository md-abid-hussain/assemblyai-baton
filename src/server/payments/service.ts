import "server-only";

import type { PolicyRecord } from "../../core/contracts/case";
import { BatonError } from "../../core/contracts/errors";
import type { PaymentViewExt, StagePayload } from "../../core/contracts/ext/wp6-payments";
import type { SendEsignAndPayLinkFinalResult } from "../../core/contracts/tools";
import { newId as defaultNewId } from "../../lib/ids";
import { log as rootLog, type Logger } from "../log";
import type { PolarApi } from "../polar/client";
import type { MappedPolarEvent } from "../polar/webhook";
import { formatUsd, fromPolarCheckoutStatus, isTerminal } from "./machine";
import { MockPaymentProvider, PolarPaymentProvider, polarOriginOf, type PolarProviderConfig } from "./providers";
import type { PaymentRecord, PaymentStore } from "./store";

/**
 * The payment service (DESIGN §5.12): creates the checkout for `send_esign_and_pay_link`, serves the fail-closed
 * status (#15, with server polls of Polar), records e-sign consent (#16), simulates (#17), records the hold timeout,
 * and applies verified webhooks (#18). It never trusts a client-reported success: no method accepts one.
 */

export const POLAR_UNAVAILABLE_LABEL = "Simulated payment (Polar unavailable)";
export const PAY_FAIL_INSTRUCTION = "Tell the customer the link stays valid for 24 hours and offer to hand back to the rep.";
/** Server GETs Polar at most this often per payment while `open`/`confirmed` (§5.12 "Polling"). */
export const SERVER_POLL_INTERVAL_MS = 8_000;
/** Even `reconcile=1` polls at most this often per payment (keeps us far under Polar's 100 req/min). */
export const RECONCILE_MIN_INTERVAL_MS = 1_500;
/** §5.12 "Errors: 1 retry after 1 s". */
export const CREATE_RETRY_DELAY_MS = 1_000;

export type PaymentsMode = "polar" | "mock";

export interface PaymentServiceDeps {
  store: PaymentStore;
  /** null when Polar is not configured (no token or product id): every payment is mock. */
  polar: PolarApi | null;
  polarConfig: PolarProviderConfig | null;
  /** `app_flags.payments_mode_override` ?? `PAYMENTS_MODE`. */
  mode(): Promise<PaymentsMode>;
  /** Moves the takeover to `close` and returns the stage payload once a payment succeeded (the tool layer). */
  stagePayloadFor?: (p: PaymentRecord) => Promise<StagePayload | null>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  newId?: () => string;
  log?: Logger;
}

export interface CreatePaymentInput {
  caseId: string;
  takeoverId: string;
  scenarioId: string;
  amountCents: number;
  policy: PolicyRecord;
  /** The browser's Origin (validated against EMBED_ORIGINS / APP_URL for `embedOrigin`). */
  origin: string;
}

export class PaymentService {
  private readonly lastPoll = new Map<string, number>();
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly newId: () => string;
  private readonly log: Logger;
  private readonly mock = new MockPaymentProvider();

  constructor(private readonly deps: PaymentServiceDeps) {
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.newId = deps.newId ?? defaultNewId;
    this.log = (deps.log ?? rootLog).child({ component: "payments" });
  }

  get store(): PaymentStore {
    return this.deps.store;
  }

  /**
   * Create the payment and its checkout. Polar errors get one retry after 1 s, then the payment falls back to mock
   * (label "Simulated payment (Polar unavailable)"). The amount check runs on Polar's `total_amount` at once.
   */
  async create(i: CreatePaymentInput): Promise<{ payment: PaymentRecord; label: string | null }> {
    if (!Number.isInteger(i.amountCents) || i.amountCents <= 0) throw new BatonError("E_CASE_STATE", "The amount due must be positive.");
    const id = this.newId();
    const mode = await this.deps.mode();
    const polarReady = mode === "polar" && this.deps.polar !== null && this.deps.polarConfig !== null;
    const base = { id, caseId: i.caseId, takeoverId: i.takeoverId, amountCents: i.amountCents };
    if (!polarReady) {
      const out = await this.mock.createCheckout({ ...i, paymentId: id });
      const row = await this.deps.store.insert({ ...base, provider: "mock", totalAmountCents: out.totalAmountCents, taxAmountCents: out.taxAmountCents, status: "open" });
      return { payment: row, label: mode === "polar" ? POLAR_UNAVAILABLE_LABEL : null };
    }

    await this.deps.store.insert({ ...base, provider: "polar", status: "created" });
    const provider = new PolarPaymentProvider(this.deps.polar!, this.deps.polarConfig!);
    let out: Awaited<ReturnType<PolarPaymentProvider["createCheckout"]>> | null = null;
    for (let attempt = 0; attempt < 2 && !out; attempt++) {
      try {
        out = await provider.createCheckout({ ...i, paymentId: id });
      } catch (err) {
        this.log.warn("polar checkout create failed", { paymentId: id, attempt, err: errName(err) });
        if (attempt === 0) await this.sleep(CREATE_RETRY_DELAY_MS);
      }
    }
    if (!out || !out.checkoutId) {
      const row = await this.deps.store.patch(id, { provider: "mock", totalAmountCents: i.amountCents, taxAmountCents: 0 });
      const opened = await this.deps.store.transition(id, "open", "create");
      return { payment: opened ?? row!, label: POLAR_UNAVAILABLE_LABEL };
    }
    await this.deps.store.patch(id, {
      checkoutId: out.checkoutId,
      checkoutUrl: out.url,
      totalAmountCents: out.totalAmountCents,
      taxAmountCents: out.taxAmountCents,
    });
    const opened = await this.deps.store.transition(id, "open", "create");
    this.lastPoll.set(id, this.now());
    if (out.totalAmountCents !== i.amountCents) {
      this.log.warn("amount mismatch on create", { paymentId: id, amountCents: i.amountCents, totalAmountCents: out.totalAmountCents });
      const failed = await this.deps.store.transition(id, "failed", "amount_mismatch", { failureReason: "amount_mismatch" });
      return { payment: failed ?? opened!, label: null };
    }
    return { payment: opened!, label: null };
  }

  async get(id: string): Promise<PaymentRecord> {
    const p = await this.deps.store.get(id);
    if (!p) throw new BatonError("E_NOT_FOUND", "No such payment.");
    return p;
  }

  /**
   * #15: the server-authoritative view. While a Polar payment is `open`/`confirmed`/`timeout` it GETs the checkout
   * from Polar first when the last server check is older than 8 s, or on `reconcile` (at most every 1.5 s).
   */
  async view(id: string, opts: { reconcile?: boolean } = {}): Promise<PaymentViewExt> {
    let p = await this.get(id);
    if (this.shouldPoll(p, !!opts.reconcile)) p = await this.pollPolar(p);
    return this.toView(p);
  }

  private shouldPoll(p: PaymentRecord, reconcile: boolean): boolean {
    if (p.provider !== "polar" || p.simulated || !p.checkoutId || !this.deps.polar) return false;
    if (p.status !== "open" && p.status !== "confirmed" && p.status !== "timeout" && p.status !== "created") return false;
    const last = this.lastPoll.get(p.id) ?? 0;
    const age = this.now() - last;
    return reconcile ? age >= RECONCILE_MIN_INTERVAL_MS : age >= SERVER_POLL_INTERVAL_MS;
  }

  /** One server GET of the Polar checkout; applies the amount check and the forward-only transition. */
  async pollPolar(p: PaymentRecord): Promise<PaymentRecord> {
    this.lastPoll.set(p.id, this.now());
    let co: Awaited<ReturnType<PolarApi["getCheckout"]>>;
    try {
      co = await this.deps.polar!.getCheckout(p.checkoutId!);
    } catch (err) {
      this.log.warn("polar checkout get failed", { paymentId: p.id, err: errName(err) });
      return p;
    }
    const status = fromPolarCheckoutStatus(co.status);
    if (co.totalAmount !== p.amountCents) {
      this.log.warn("amount mismatch on poll", { paymentId: p.id, amountCents: p.amountCents, totalAmountCents: co.totalAmount });
      return (await this.deps.store.transition(p.id, "failed", "amount_mismatch", { failureReason: "amount_mismatch", totalAmountCents: co.totalAmount }, { notSimulated: true })) ?? (await this.get(p.id));
    }
    if (!status || status === "open" || status === p.status) return p;
    const next = await this.deps.store.transition(
      p.id,
      status,
      "server_poll",
      { statusSource: "server_poll", totalAmountCents: co.totalAmount, taxAmountCents: co.taxAmount, ...(status === "failed" ? { failureReason: "polar_failed" } : {}) },
      { notSimulated: true },
    );
    if (next) this.log.info("payment status from server poll", { paymentId: p.id, from: p.status, to: status });
    return next ?? (await this.get(p.id));
  }

  /** #18 after verification and idempotency: apply one mapped Polar event. */
  async applyWebhook(ev: MappedPolarEvent): Promise<"applied" | "noop" | "not_found" | "ignored_simulated" | "amount_mismatch"> {
    const p = (ev.checkoutId ? await this.deps.store.getByCheckout(ev.checkoutId) : null) ?? (ev.paymentId ? await this.deps.store.get(ev.paymentId) : null);
    if (!p) return "not_found";
    if (p.simulated) {
      this.log.info("webhook ignored: payment was simulated", { paymentId: p.id, type: ev.type, status: ev.status });
      return "ignored_simulated";
    }
    if (ev.totalAmountCents !== null && ev.totalAmountCents !== p.amountCents) {
      this.log.warn("amount mismatch on webhook", { paymentId: p.id, amountCents: p.amountCents, totalAmountCents: ev.totalAmountCents });
      const f = await this.deps.store.transition(p.id, "failed", "amount_mismatch", { failureReason: "amount_mismatch", totalAmountCents: ev.totalAmountCents }, { notSimulated: true });
      return f ? "amount_mismatch" : "noop";
    }
    const next = await this.deps.store.transition(
      p.id,
      ev.status,
      "webhook",
      {
        statusSource: "webhook",
        ...(ev.totalAmountCents !== null ? { totalAmountCents: ev.totalAmountCents } : {}),
        ...(ev.taxAmountCents !== null ? { taxAmountCents: ev.taxAmountCents } : {}),
        ...(ev.status === "failed" ? { failureReason: "polar_failed" } : {}),
      },
      { notSimulated: true },
    );
    if (next) this.log.info("payment status from webhook", { paymentId: p.id, from: p.status, to: ev.status, type: ev.type });
    return next ? "applied" : "noop";
  }

  /** #16: record e-sign consent with a timestamp (the typed name is the policyholder's, editable). */
  async esign(id: string, typedName: string): Promise<{ signedAt: string }> {
    const p = await this.get(id);
    if (p.esignConsentAt) return { signedAt: p.esignConsentAt.toISOString() };
    const at = new Date(this.now());
    await this.deps.store.esign(id, typedName.trim().slice(0, 80), at);
    return { signedAt: at.toISOString() };
  }

  /**
   * #17: any provider, any PAYMENTS_MODE, from every non-succeeded status: provider → mock, simulated, `succeeded`
   * with source `mock`. Later Polar webhooks for it are ignored (logged). Idempotent.
   */
  async simulate(id: string): Promise<PaymentRecord> {
    const p = await this.get(id);
    if (p.status === "succeeded") return p;
    const next = await this.deps.store.transition(id, "succeeded", "simulate", {
      provider: "mock",
      simulated: true,
      statusSource: "mock",
      failureReason: null,
      totalAmountCents: p.totalAmountCents ?? p.amountCents,
    });
    if (next) this.log.info("payment simulated", { paymentId: id, from: p.status });
    return next ?? (await this.get(id));
  }

  /** The hold handler's deadline: `timeout` from a non-terminal status only (never overrides a result). */
  async markTimeout(id: string): Promise<PaymentRecord> {
    const p = await this.get(id);
    return (await this.deps.store.transition(id, "timeout", "timeout")) ?? p;
  }

  /** The #15 body (+ WP6 extras). */
  async toView(p: PaymentRecord): Promise<PaymentViewExt> {
    const livePolar = p.provider === "polar" && !p.simulated && !!p.checkoutUrl;
    const view: PaymentViewExt = {
      id: p.id,
      status: p.status,
      statusSource: p.statusSource,
      amountCents: p.amountCents,
      totalAmountCents: p.totalAmountCents,
      provider: p.provider,
      simulated: p.simulated,
      ...(livePolar ? { checkoutUrl: p.checkoutUrl! } : {}),
      embed: livePolar ? { url: p.checkoutUrl!, origin: polarOriginOf(p.checkoutUrl!) } : null,
      ...(p.failureReason ? { failureReason: p.failureReason } : {}),
      updatedAt: p.updatedAt.toISOString(),
      label: labelOf(p),
      esignedAt: p.esignConsentAt ? p.esignConsentAt.toISOString() : null,
    };
    const tr = finalToolResult(p);
    if (tr) view.toolResult = tr;
    if (p.status === "succeeded" && this.deps.stagePayloadFor) {
      try {
        const sp = await this.deps.stagePayloadFor(p);
        if (sp) view.stagePayload = sp;
      } catch (err) {
        this.log.warn("stage payload failed", { paymentId: p.id, err: errName(err) });
      }
    }
    return view;
  }
}

/** Server-built final `tool.result` of the held pay tool (G0 `PaymentView.toolResult`); null while not terminal. */
export function finalToolResult(p: PaymentRecord): SendEsignAndPayLinkFinalResult | null {
  if (!isTerminal(p.status)) return null;
  if (p.status === "succeeded") {
    const verified_by = p.statusSource === "webhook" ? "polar_webhook" : p.statusSource === "server_poll" ? "polar_poll" : "simulated";
    return { status: "paid", amount: formatUsd(p.totalAmountCents ?? p.amountCents), receipt: receiptOf(p.id), verified_by };
  }
  return { status: p.status === "failed" ? "failed" : "expired", instruction: PAY_FAIL_INSTRUCTION };
}

/** "PAY-7K3QX2" (stable per payment). */
export function receiptOf(paymentId: string): string {
  const alnum = paymentId.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  return `PAY-${alnum.slice(-6).padStart(6, "0")}`;
}

/** Plain-words provenance (phone Done screen, QA card). */
export function labelOf(p: PaymentRecord): string {
  if (p.status === "succeeded") {
    if (p.simulated || p.statusSource === "mock") return "Simulated";
    return p.statusSource === "webhook" ? "Verified by Polar webhook" : "Verified with Polar";
  }
  if (p.status === "failed") return p.failureReason === "amount_mismatch" ? "Amount did not match: payment stopped" : "Payment failed";
  if (p.status === "expired") return "Checkout expired";
  if (p.status === "timeout") return "Still waiting for payment";
  if (p.provider === "mock") return "Simulated payment";
  return p.status === "confirmed" ? "Waiting for Polar to confirm… we only trust the webhook" : "Polar sandbox checkout";
}

function errName(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message.slice(0, 160)}`;
  return String(err).slice(0, 160);
}
