import "server-only";

import { Webhook } from "standardwebhooks";

import type { PaymentStatus } from "../../core/contracts/case";

/**
 * Polar webhook verification and event mapping (DESIGN §5.12). Polar signs with Standard Webhooks. Its dashboard
 * secret is used in two ways in the wild: as a Standard Webhooks key as-is (`whsec_…` / base64), or (Polar's own SDK
 * `validateEvent`) as UTF-8 text that is base64-encoded first. We accept both, and nothing else.
 */

export class PolarSignatureError extends Error {
  constructor() {
    super("Polar webhook signature did not verify");
    this.name = "PolarSignatureError";
  }
}

export function verifyPolarWebhook(raw: string, headers: Headers, secret: string): unknown {
  const h = {
    "webhook-id": headers.get("webhook-id") ?? "",
    "webhook-timestamp": headers.get("webhook-timestamp") ?? "",
    "webhook-signature": headers.get("webhook-signature") ?? "",
  };
  const attempts = [secret, Buffer.from(secret, "utf-8").toString("base64")]; // Standard Webhooks as-is, then legacy Polar HMAC
  for (const key of attempts) {
    try {
      return new Webhook(key).verify(raw, h);
    } catch {
      /* next scheme */
    }
  }
  throw new PolarSignatureError();
}

/** What a verified Polar event means for one of our payments. */
export interface MappedPolarEvent {
  type: string;
  /** Polar checkout id (checkout.* → data.id; order.* → data.checkout_id). */
  checkoutId: string | null;
  /** Our payment id from the checkout/order metadata (fallback lookup). */
  paymentId: string | null;
  status: PaymentStatus;
  /** Polar's total_amount in cents, when the payload carries it (the amount check runs on it). */
  totalAmountCents: number | null;
  taxAmountCents: number | null;
}

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const int = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? Math.round(v) : null);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/**
 * Map a verified event (Polar's JSON is snake_case):
 * - `checkout.updated` with `data.status` ∈ {confirmed, succeeded, failed, expired};
 * - `order.paid` → `succeeded`;
 * - `checkout.expired` → `expired`.
 * Anything else → null (202, ignored).
 */
export function mapPolarEvent(payload: unknown): MappedPolarEvent | null {
  const ev = obj(payload);
  const type = str(ev.type);
  const data = obj(ev.data);
  if (!type) return null;
  const meta = obj(data.metadata);
  const paymentId = str(meta.paymentId) ?? str(meta.payment_id);
  if (type === "checkout.updated" || type === "checkout.expired") {
    const status = type === "checkout.expired" ? "expired" : str(data.status);
    if (status !== "confirmed" && status !== "succeeded" && status !== "failed" && status !== "expired") return null;
    return {
      type,
      checkoutId: str(data.id),
      paymentId,
      status,
      totalAmountCents: int(data.total_amount),
      taxAmountCents: int(data.tax_amount),
    };
  }
  if (type === "order.paid") {
    return {
      type,
      checkoutId: str(data.checkout_id),
      paymentId,
      status: "succeeded",
      totalAmountCents: int(data.total_amount),
      taxAmountCents: int(data.tax_amount),
    };
  }
  return null;
}

/** The redacted copy stored in `webhook_events.payload` (ids, type, status and amounts only; no customer data). */
export function redactPolarPayload(payload: unknown): Record<string, unknown> {
  const ev = obj(payload);
  const data = obj(ev.data);
  const meta = obj(data.metadata);
  return {
    type: str(ev.type),
    id: str(data.id),
    checkout_id: str(data.checkout_id),
    status: str(data.status),
    total_amount: int(data.total_amount),
    tax_amount: int(data.tax_amount),
    paymentId: str(meta.paymentId),
  };
}
