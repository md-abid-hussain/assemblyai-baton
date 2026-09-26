/**
 * WP16·3: `payment.succeeded` (SAAS §7.1) — emitted where a payment becomes verified, fail-closed.
 *
 * - the webhook path emits `verified_webhook`, the server poll `verified_poll`, and the server-side Simulate
 *   `verified_poll` with `provider:"simulated"` (the only two provider values the contract allows);
 * - a payment that is not `succeeded` emits nothing, and no client-reported success exists to emit from;
 * - it is idempotent on `payment.succeeded:<paymentId>`, so a replayed webhook delivers once;
 * - nothing is emitted while the run's case has no org (SAAS §2.6: events are not back-filled);
 * - the payload is thin: ids, an amount and links — no case fields, no customer data;
 * - an outbox failure never fails the payment transition that produced it.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { PaymentSucceededData } from "@/core/contracts/v3/events";
import type { Db } from "@/server/db/client";
import { emitPaymentSucceeded, providerOf, verifiedByOf } from "@/server/payments/domain-events";
import { PaymentService } from "@/server/payments/service";
import type { PaymentRecord } from "@/server/payments/store";
import { resetCaseOrgColumnCache } from "@/server/qa/domain-events";
import { createMemoryDomainEvents, resetSaasPorts, setDomainEvents, type MemoryDomainEvents } from "@/server/saas/ports";
import { clock, FakePolar, MemoryPaymentStore, policy } from "../tools/helpers";

/** A `Db` stand-in for the two reads `orgOfCase` makes: the column probe and the row. */
function fakeDb(orgId: string | null): Db {
  return {
    async execute(q: unknown) {
      const sql = String((q as { queryChunks?: unknown[] })?.queryChunks?.map((c) => String(c)).join(" ") ?? q);
      if (sql.includes("information_schema")) return { rows: [{ ok: 1 }] };
      return { rows: orgId === null ? [{ org_id: null }] : [{ org_id: orgId }] };
    },
  } as unknown as Db;
}

const ORG = "org_acme";

describe("payment.succeeded", () => {
  let events: MemoryDomainEvents;

  beforeEach(() => {
    resetSaasPorts();
    resetCaseOrgColumnCache();
    events = createMemoryDomainEvents();
    setDomainEvents(events);
  });
  afterEach(() => {
    resetSaasPorts();
    resetCaseOrgColumnCache();
  });

  function setup(mode: "polar" | "mock" = "polar") {
    const store = new MemoryPaymentStore();
    const polar = new FakePolar();
    const c = clock();
    let n = 0;
    const svc = new PaymentService({
      store,
      polar,
      polarConfig: { productId: "prod_1", demoCustomers: { s01: "cus_priya" }, embedOrigins: [], appUrl: "https://changeover.app" },
      mode: async () => mode,
      now: c.now,
      sleep: async () => undefined,
      newId: () => `pay_${++n}`,
      emitSucceeded: (p) => emitPaymentSucceeded(p, { db: fakeDb(ORG), appUrl: "https://changeover.app" }),
    });
    const create = (amountCents = 2340) =>
      svc.create({ caseId: "case_1", takeoverId: "tko_1", scenarioId: "s01", amountCents, policy, origin: "https://changeover.app" });
    return { store, polar, svc, create };
  }

  it("a verified Polar webhook emits `verified_webhook` with a thin, valid payload", async () => {
    const { svc, create } = setup();
    const { payment } = await create(2340);
    const applied = await svc.applyWebhook({
      type: "checkout.updated", checkoutId: payment.checkoutId ?? "co_1", paymentId: payment.id,
      status: "succeeded", totalAmountCents: 2340, taxAmountCents: 0,
    });
    expect(applied).toBe("applied");
    expect(events.events).toHaveLength(1);
    const ev = events.events[0]!;
    expect(ev.type).toBe("payment.succeeded");
    expect(ev.orgId).toBe(ORG);
    expect(ev.dedupeKey).toBe(`payment.succeeded:${payment.id}`);
    const data = PaymentSucceededData.parse(ev.data);
    expect(data).toMatchObject({
      run_id: "tko_1", payment_id: payment.id, amount: 23.4, currency: "USD",
      provider: "polar_sandbox", verified_by: "verified_webhook",
    });
    expect(data.links.api).toBe("https://changeover.app/api/v1/runs/tko_1");
    // Thin: no case fields, no customer, no transcript.
    expect(Object.keys(data).sort()).toEqual(["amount", "currency", "links", "payment_id", "provider", "run_id", "verified_by"]);
  });

  it("a replayed webhook delivers once (idempotent on the payment id)", async () => {
    const { svc, create } = setup();
    const { payment } = await create();
    const ev = {
      type: "checkout.updated", checkoutId: payment.checkoutId ?? "co_1", paymentId: payment.id,
      status: "succeeded" as const, totalAmountCents: 2340, taxAmountCents: 0,
    };
    await svc.applyWebhook(ev);
    await svc.applyWebhook(ev);
    expect(events.events.filter((e) => e.type === "payment.succeeded")).toHaveLength(1);
  });

  it("the server-side Simulate emits `verified_poll` with provider `simulated`", async () => {
    const { svc, create } = setup("mock");
    const { payment } = await create();
    await svc.simulate(payment.id);
    const data = PaymentSucceededData.parse(events.events[0]!.data);
    expect(data).toMatchObject({ provider: "simulated", verified_by: "verified_poll" });
  });

  it("emits nothing for a payment that is not succeeded, and nothing before the case has an org", async () => {
    const notPaid = { id: "pay_x", caseId: "case_1", takeoverId: "tko_1", status: "open", statusSource: null, simulated: false, provider: "polar", amountCents: 100, totalAmountCents: null } as unknown as PaymentRecord;
    expect(await emitPaymentSucceeded(notPaid, { db: fakeDb(ORG) })).toBe(false);

    const paid = { ...notPaid, status: "succeeded", statusSource: "webhook" } as unknown as PaymentRecord;
    expect(await emitPaymentSucceeded(paid, { db: fakeDb(null) })).toBe(false);
    expect(events.events).toHaveLength(0);
  });

  it("an outbox failure never fails the transition", async () => {
    setDomainEvents({
      async emit() {
        throw new Error("outbox down");
      },
    });
    const { svc, create } = setup();
    const { payment } = await create();
    const applied = await svc.applyWebhook({
      type: "checkout.updated", checkoutId: payment.checkoutId ?? "co_1", paymentId: payment.id,
      status: "succeeded", totalAmountCents: 2340, taxAmountCents: 0,
    });
    expect(applied).toBe("applied");
    expect((await svc.get(payment.id)).status).toBe("succeeded");
  });

  it("maps the status source and the provider the way the contract's enums do", () => {
    const base = { id: "p", caseId: "c", takeoverId: "t", amountCents: 100, totalAmountCents: 100 } as unknown as PaymentRecord;
    expect(verifiedByOf({ ...base, status: "succeeded", statusSource: "webhook" } as PaymentRecord)).toBe("verified_webhook");
    expect(verifiedByOf({ ...base, status: "succeeded", statusSource: "server_poll" } as PaymentRecord)).toBe("verified_poll");
    expect(verifiedByOf({ ...base, status: "succeeded", statusSource: "mock" } as PaymentRecord)).toBe("verified_poll");
    expect(verifiedByOf({ ...base, status: "timeout", statusSource: "webhook" } as PaymentRecord)).toBeNull();
    expect(providerOf({ ...base, provider: "polar", simulated: false } as PaymentRecord)).toBe("polar_sandbox");
    expect(providerOf({ ...base, provider: "polar", simulated: true } as PaymentRecord)).toBe("simulated");
    expect(providerOf({ ...base, provider: "mock", simulated: false } as PaymentRecord)).toBe("simulated");
  });
});
