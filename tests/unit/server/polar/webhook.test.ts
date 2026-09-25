/**
 * WP6 acceptance 1 (part): Polar webhook verification accepts both signing schemes and rejects tampering.
 */
import { randomBytes } from "node:crypto";

import { Webhook } from "standardwebhooks";
import { describe, expect, it } from "vitest";

import { mapPolarEvent, PolarSignatureError, redactPolarPayload, verifyPolarWebhook } from "@/server/polar/webhook";

const body = JSON.stringify({
  type: "checkout.updated",
  timestamp: "2026-09-25T12:00:00Z",
  data: { id: "co_1", status: "succeeded", total_amount: 2340, tax_amount: 0, metadata: { paymentId: "pay_1" }, customer_email: "x@example.com" },
});

function signed(key: string, payload = body, id = "msg_1") {
  const ts = new Date();
  const sig = new Webhook(key).sign(id, ts, payload);
  return new Headers({ "webhook-id": id, "webhook-timestamp": String(Math.floor(ts.getTime() / 1000)), "webhook-signature": sig });
}

describe("verifyPolarWebhook (DESIGN §5.12)", () => {
  it("scheme 1: a Standard Webhooks secret used as-is (whsec_ base64)", () => {
    const secret = `whsec_${randomBytes(24).toString("base64")}`;
    const ev = verifyPolarWebhook(body, signed(secret), secret) as { type: string };
    expect(ev.type).toBe("checkout.updated");
  });

  it("scheme 2: Polar's legacy use (the UTF-8 secret, base64-encoded first)", () => {
    const secret = `polar_whs_${randomBytes(18).toString("hex")}`;
    const key = Buffer.from(secret, "utf-8").toString("base64");
    const ev = verifyPolarWebhook(body, signed(key), secret) as { type: string };
    expect(ev.type).toBe("checkout.updated");
  });

  it("rejects a tampered body, a wrong secret, a missing signature and a stale timestamp", () => {
    const secret = `whsec_${randomBytes(24).toString("base64")}`;
    const h = signed(secret);
    expect(() => verifyPolarWebhook(body.replace("2340", "1"), h, secret)).toThrow(PolarSignatureError);
    expect(() => verifyPolarWebhook(body, h, `whsec_${randomBytes(24).toString("base64")}`)).toThrow(PolarSignatureError);
    const noSig = new Headers(h);
    noSig.delete("webhook-signature");
    expect(() => verifyPolarWebhook(body, noSig, secret)).toThrow(PolarSignatureError);
    const old = new Date(Date.now() - 10 * 60_000);
    const stale = new Headers({
      "webhook-id": "msg_2",
      "webhook-timestamp": String(Math.floor(old.getTime() / 1000)),
      "webhook-signature": new Webhook(secret).sign("msg_2", old, body),
    });
    expect(() => verifyPolarWebhook(body, stale, secret)).toThrow(PolarSignatureError);
  });
});

describe("mapPolarEvent", () => {
  it("maps checkout.updated statuses, order.paid and checkout.expired; ignores the rest", () => {
    expect(mapPolarEvent(JSON.parse(body))).toEqual({
      type: "checkout.updated", checkoutId: "co_1", paymentId: "pay_1", status: "succeeded", totalAmountCents: 2340, taxAmountCents: 0,
    });
    expect(mapPolarEvent({ type: "checkout.updated", data: { id: "co_1", status: "confirmed" } })?.status).toBe("confirmed");
    expect(mapPolarEvent({ type: "checkout.updated", data: { id: "co_1", status: "open" } })).toBeNull();
    expect(mapPolarEvent({ type: "order.paid", data: { id: "ord_1", checkout_id: "co_9", total_amount: 100, metadata: {} } })).toMatchObject({
      checkoutId: "co_9", status: "succeeded", totalAmountCents: 100,
    });
    expect(mapPolarEvent({ type: "checkout.expired", data: { id: "co_2" } })?.status).toBe("expired");
    expect(mapPolarEvent({ type: "customer.created", data: {} })).toBeNull();
    expect(mapPolarEvent("nope")).toBeNull();
  });

  it("the stored copy is redacted (no customer data)", () => {
    const r = redactPolarPayload(JSON.parse(body));
    expect(JSON.stringify(r)).not.toContain("example.com");
    expect(r).toMatchObject({ type: "checkout.updated", id: "co_1", status: "succeeded", total_amount: 2340, paymentId: "pay_1" });
  });
});
