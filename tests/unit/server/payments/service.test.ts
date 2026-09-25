/**
 * WP6 acceptance 2 and 5 (service level, $0): the fail-closed payment state machine, the amount check, simulate from
 * every non-terminal state in both modes, the Polar-unavailable fallback, server polling, and a late webhook after
 * the hold timeout.
 */
import { describe, expect, it } from "vitest";

import type { PaymentStatus } from "@/core/contracts/case";
import { allowedFrom, canTransition, formatUsd, usdToCents } from "@/server/payments/machine";
import { PaymentService, paymentViewOf, POLAR_UNAVAILABLE_LABEL, receiptOf, SERVER_POLL_INTERVAL_MS, type PaymentsMode } from "@/server/payments/service";
import type { PaymentRecord } from "@/server/payments/store";
import { buildCheckoutCreate, validatedEmbedOrigin } from "@/server/polar/client";
import { clock, FakePolar, MemoryPaymentStore, policy } from "../tools/helpers";

function setup(mode: PaymentsMode = "polar") {
  const store = new MemoryPaymentStore();
  const polar = new FakePolar();
  const c = clock();
  let n = 0;
  const svc = new PaymentService({
    store,
    polar,
    polarConfig: { productId: "prod_1", demoCustomers: { s01: "cus_priya" }, embedOrigins: ["http://localhost:3107"], appUrl: "https://baton.example.app" },
    mode: async () => mode,
    now: c.now,
    sleep: async () => undefined,
    newId: () => `pay_${++n}`,
  });
  const create = (amountCents = 2340) =>
    svc.create({ caseId: "case_1", takeoverId: "tko_1", scenarioId: "s01", amountCents, policy, origin: "http://localhost:3107" });
  return { store, polar, svc, c, create };
}

describe("payment state machine (pure)", () => {
  it("is forward-only; succeeded only via webhook, server poll, mock or simulate", () => {
    expect(canTransition("open", "succeeded", "webhook")).toBe(true);
    expect(canTransition("succeeded", "open", "webhook")).toBe(false);
    expect(canTransition("succeeded", "failed", "webhook")).toBe(false);
    expect(canTransition("confirmed", "open", "server_poll")).toBe(false);
    expect(canTransition("timeout", "succeeded", "webhook")).toBe(true);
    expect(canTransition("succeeded", "timeout", "timeout")).toBe(false);
    expect(canTransition("failed", "succeeded", "webhook")).toBe(false);
    for (const s of ["created", "open", "confirmed", "failed", "expired", "timeout"] as PaymentStatus[]) {
      expect(canTransition(s, "succeeded", "simulate")).toBe(true);
    }
    // No via sets anything from a client report: there is no such via at all.
    expect(allowedFrom("succeeded", "create")).toEqual([]);
  });

  it("formats money", () => {
    expect(formatUsd(2340)).toBe("$23.40");
    expect(formatUsd(5)).toBe("$0.05");
    expect(usdToCents("27.85")).toBe(2785);
    expect(receiptOf("pay_1")).toMatch(/^PAY-[A-Z0-9]{6}$/);
  });
});

describe("checkout request (DESIGN §5.12)", () => {
  it("builds the ad-hoc tax-inclusive fixed price, customer, address, no discounts, embedOrigin, metadata", () => {
    const req = buildCheckoutCreate({
      productId: "prod_1", amountCents: 2340, customerId: "cus_1", policy, embedOrigin: "http://localhost:3107",
      metadata: { paymentId: "pay_1", caseId: "c", takeoverId: "t" },
    });
    expect(req).toMatchObject({
      products: ["prod_1"],
      prices: { prod_1: [{ amountType: "fixed", priceAmount: 2340, priceCurrency: "usd", taxBehavior: "inclusive" }] },
      customerId: "cus_1",
      customerBillingAddress: { country: "US", line1: "1427 Belle Avenue", city: "Lakewood", state: "US-OH", postalCode: "44107" },
      allowDiscountCodes: false,
      embedOrigin: "http://localhost:3107",
      metadata: { paymentId: "pay_1", caseId: "c", takeoverId: "t" },
    });
    expect(req).not.toHaveProperty("successUrl");
  });

  it("validates embedOrigin against EMBED_ORIGINS, else APP_URL", () => {
    expect(validatedEmbedOrigin("http://localhost:3107", ["http://localhost:3107"], "https://app.x")).toBe("http://localhost:3107");
    expect(validatedEmbedOrigin("https://evil.example", ["http://localhost:3107"], "https://app.x/path")).toBe("https://app.x");
    expect(validatedEmbedOrigin("https://app.x", [], "https://app.x")).toBe("https://app.x");
    expect(validatedEmbedOrigin(null, [], null)).toBeNull();
  });
});

describe("PaymentService", () => {
  it("polar mode: creates an open checkout whose total equals the disclosed amount", async () => {
    const { create, polar } = setup();
    const { payment, label } = await create();
    expect(payment).toMatchObject({ provider: "polar", status: "open", checkoutId: "co_1", totalAmountCents: 2340, amountCents: 2340 });
    expect(label).toBeNull();
    expect(polar.createCalls).toHaveLength(1);
    expect(polar.createCalls[0]).toMatchObject({ customerId: "cus_priya", embedOrigin: "http://localhost:3107" });
  });

  it("amount check on create: Polar total ≠ amount → failed(amount_mismatch)", async () => {
    const { create, polar, svc } = setup();
    polar.totalOverride = 2500;
    const { payment } = await create();
    expect(payment).toMatchObject({ status: "failed", failureReason: "amount_mismatch" });
    const v = await svc.view(payment.id);
    expect(v.toolResult).toMatchObject({ status: "failed" });
  });

  it("Polar errors: one retry, then the mock fallback labelled 'Simulated payment (Polar unavailable)'", async () => {
    const s1 = setup();
    s1.polar.failCreates = 1;
    expect((await s1.create()).payment).toMatchObject({ provider: "polar", status: "open" });
    expect(s1.polar.createCalls).toHaveLength(2);
    const s2 = setup();
    s2.polar.failCreates = 2;
    const r = await s2.create();
    expect(r.payment).toMatchObject({ provider: "mock", status: "open", totalAmountCents: 2340 });
    expect(r.label).toBe(POLAR_UNAVAILABLE_LABEL);
  });

  it("mock mode: no checkout; only Simulate resolves it", async () => {
    const { create, svc, polar } = setup("mock");
    const { payment } = await create();
    expect(payment).toMatchObject({ provider: "mock", status: "open", checkoutId: null, totalAmountCents: 2340 });
    expect(polar.createCalls).toHaveLength(0);
    const v = await svc.view(payment.id);
    expect(v.embed).toBeNull();
    expect(v.checkoutUrl).toBeUndefined();
    const s = await svc.simulate(payment.id);
    expect(s).toMatchObject({ status: "succeeded", statusSource: "mock", simulated: true });
    expect((await svc.view(payment.id)).toolResult).toMatchObject({ status: "paid", amount: "$23.40", verified_by: "simulated" });
  });

  it("server polling: at most every 8 s while open; reconcile forces one; succeeded via server_poll", async () => {
    const { create, svc, polar, c } = setup();
    const { payment } = await create();
    await svc.view(payment.id);
    expect(polar.getCalls).toBe(0); // create just touched Polar
    c.advance(SERVER_POLL_INTERVAL_MS);
    await svc.view(payment.id);
    expect(polar.getCalls).toBe(1);
    c.advance(1000);
    await svc.view(payment.id);
    expect(polar.getCalls).toBe(1);
    polar.setStatus("co_1", "succeeded");
    c.advance(600);
    const v = await svc.view(payment.id, { reconcile: true });
    expect(polar.getCalls).toBe(2);
    expect(v).toMatchObject({ status: "succeeded", statusSource: "server_poll", label: "Verified with Polar" });
    expect(v.toolResult).toMatchObject({ status: "paid", amount: "$23.40", verified_by: "polar_poll" });
    c.advance(60_000);
    await svc.view(payment.id);
    expect(polar.getCalls).toBe(2); // terminal: no more polls
  });

  it("amount check on poll and on webhook", async () => {
    const a = setup();
    const p = (await a.create()).payment;
    a.polar.setStatus("co_1", "succeeded", 9999);
    a.c.advance(SERVER_POLL_INTERVAL_MS);
    expect(await a.svc.view(p.id)).toMatchObject({ status: "failed", failureReason: "amount_mismatch" });

    const b = setup();
    const q = (await b.create()).payment;
    const r = await b.svc.applyWebhook({ type: "order.paid", checkoutId: "co_1", paymentId: null, status: "succeeded", totalAmountCents: 1, taxAmountCents: 0 });
    expect(r).toBe("amount_mismatch");
    expect(await b.store.get(q.id)).toMatchObject({ status: "failed", failureReason: "amount_mismatch" });
  });

  it("webhooks move forward only; confirmed then succeeded; out-of-order confirmed after succeeded is a no-op", async () => {
    const { create, svc, store } = setup();
    const p = (await create()).payment;
    const ev = (status: PaymentStatus) => ({ type: "checkout.updated", checkoutId: "co_1", paymentId: p.id, status, totalAmountCents: 2340, taxAmountCents: 0 });
    expect(await svc.applyWebhook(ev("confirmed"))).toBe("applied");
    expect(await svc.applyWebhook(ev("succeeded"))).toBe("applied");
    expect(await svc.applyWebhook(ev("confirmed"))).toBe("noop");
    expect(await svc.applyWebhook(ev("failed"))).toBe("noop");
    expect(await store.get(p.id)).toMatchObject({ status: "succeeded", statusSource: "webhook" });
    expect((await svc.view(p.id)).label).toBe("Verified by Polar webhook");
    expect(await svc.applyWebhook({ ...ev("succeeded"), checkoutId: "co_unknown", paymentId: null })).toBe("not_found");
  });

  it("simulate works from every non-terminal (and failed/expired/timeout) state, in PAYMENTS_MODE=polar", async () => {
    const prepare: Record<string, (s: ReturnType<typeof setup>, id: string) => Promise<void>> = {
      created: async (s, id) => void (s.store.rows.get(id)!.status = "created"),
      open: async () => undefined,
      confirmed: async (s) => void (await s.svc.applyWebhook({ type: "checkout.updated", checkoutId: "co_1", paymentId: null, status: "confirmed", totalAmountCents: 2340, taxAmountCents: 0 })),
      failed: async (s) => void (await s.svc.applyWebhook({ type: "checkout.updated", checkoutId: "co_1", paymentId: null, status: "failed", totalAmountCents: 2340, taxAmountCents: 0 })),
      expired: async (s) => void (await s.svc.applyWebhook({ type: "checkout.expired", checkoutId: "co_1", paymentId: null, status: "expired", totalAmountCents: null, taxAmountCents: null })),
      timeout: async (s, id) => void (await s.svc.markTimeout(id)),
    };
    for (const [from, prep] of Object.entries(prepare)) {
      const s = setup("polar");
      const p = (await s.create()).payment;
      await prep(s, p.id);
      expect((await s.store.get(p.id))!.status).toBe(from);
      const r = await s.svc.simulate(p.id);
      expect(r, from).toMatchObject({ status: "succeeded", provider: "mock", simulated: true, statusSource: "mock" });
      // Later Polar webhooks for a simulated payment are ignored (logged).
      expect(await s.svc.applyWebhook({ type: "checkout.updated", checkoutId: "co_1", paymentId: null, status: "failed", totalAmountCents: 2340, taxAmountCents: 0 })).toBe("ignored_simulated");
      expect((await s.store.get(p.id))!.status).toBe("succeeded");
      // Idempotent.
      expect((await s.svc.simulate(p.id)).status).toBe("succeeded");
    }
  });

  it("a late webhook after the hold timeout still reaches succeeded (acceptance 5)", async () => {
    const { create, svc } = setup();
    const p = (await create()).payment;
    expect((await svc.markTimeout(p.id)).status).toBe("timeout");
    expect((await svc.view(p.id)).toolResult).toBeUndefined(); // the client builds `timeout` itself
    expect(await svc.applyWebhook({ type: "order.paid", checkoutId: "co_1", paymentId: null, status: "succeeded", totalAmountCents: 2340, taxAmountCents: 0 })).toBe("applied");
    expect((await svc.view(p.id)).toolResult).toMatchObject({ status: "paid", verified_by: "polar_webhook" });
    // …and a timeout never overrides a result.
    expect((await svc.markTimeout(p.id)).status).toBe("succeeded");
  });

  it("e-sign records consent and a timestamp but never changes the payment status", async () => {
    const { create, svc, store } = setup();
    const p = (await create()).payment;
    const r = await svc.esign(p.id, "  Priya Raman ");
    expect(r.signedAt).toMatch(/^2026-09-25T/);
    expect(await store.get(p.id)).toMatchObject({ status: "open", esignName: "Priya Raman" });
    expect((await svc.view(p.id)).esignedAt).toBe(r.signedAt);
  });

  it("the view exposes the embed (URL + Polar origin) only for a live Polar checkout", async () => {
    const { create, svc } = setup();
    const p = (await create()).payment;
    const v = await svc.view(p.id);
    expect(v.embed).toEqual({ url: "https://sandbox.polar.sh/checkout/co_1", origin: "https://sandbox.polar.sh" });
    expect(v.checkoutUrl).toBe("https://sandbox.polar.sh/checkout/co_1");
    await svc.simulate(p.id);
    expect((await svc.view(p.id)).embed).toBeNull();
  });
});

describe("paymentViewOf (pure; WP3 route #4 summary, wp3-to-wp6 item 3)", () => {
  const row = (o: Partial<PaymentRecord>): PaymentRecord => ({
    id: "pay_ABC123xyz", caseId: "c1", takeoverId: "t1", provider: "polar", amountCents: 2340, checkoutId: "co_1",
    checkoutUrl: "https://sandbox.polar.sh/checkout/polar_c_1", totalAmountCents: 2340, taxAmountCents: 0, simulated: false,
    status: "open", statusSource: null, failureReason: null, esignConsentAt: null, esignName: null,
    createdAt: new Date(0), updatedAt: new Date(1000), ...o,
  });
  it("open Polar checkout: embed + hosted URL, no tool result", () => {
    const v = paymentViewOf(row({}));
    expect(v.embed).toEqual({ url: "https://sandbox.polar.sh/checkout/polar_c_1", origin: "https://sandbox.polar.sh" });
    expect(v.checkoutUrl).toBe("https://sandbox.polar.sh/checkout/polar_c_1");
    expect(v.toolResult).toBeUndefined();
    expect(v.stagePayload).toBeUndefined();
  });
  it("succeeded by webhook: paid tool result verified by the webhook; simulated rows hide the embed", () => {
    const v = paymentViewOf(row({ status: "succeeded", statusSource: "webhook" }));
    expect(v.toolResult).toEqual({ status: "paid", amount: "$23.40", receipt: receiptOf("pay_ABC123xyz"), verified_by: "polar_webhook" });
    expect(v.label).toBe("Verified by Polar webhook");
    const s = paymentViewOf(row({ status: "succeeded", statusSource: "mock", simulated: true, provider: "mock" }));
    expect(s.embed).toBeNull();
    expect(s.toolResult).toMatchObject({ status: "paid", verified_by: "simulated" });
  });
});
