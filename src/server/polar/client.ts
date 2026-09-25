import "server-only";

import { Polar } from "@polar-sh/sdk";
import type { Checkout } from "@polar-sh/sdk/models/components/checkout.js";
import type { CheckoutCreate } from "@polar-sh/sdk/models/components/checkoutcreate.js";

import type { PolicyRecord } from "../../core/contracts/case";

/**
 * Polar (sandbox) access for payments (DESIGN §5.12). `PolarApi` is the seam the payment service and the tests use;
 * `sdkPolarApi()` is the real one on `@polar-sh/sdk` 0.49.0. The access token never leaves this module and is never
 * logged (the SDK does not log requests).
 */

/** The checkout fields we use (the SDK's camelCase names). `clientSecret` is never persisted (§5.12). */
export interface PolarCheckout {
  id: string;
  url: string;
  status: string;
  amount: number;
  totalAmount: number;
  taxAmount: number | null;
  embedOrigin: string | null;
  customerId: string | null;
  metadata: Record<string, unknown>;
  expiresAt: string | null;
}

export interface PolarApi {
  createCheckout(req: CheckoutCreate): Promise<PolarCheckout>;
  getCheckout(id: string): Promise<PolarCheckout>;
}

export function toPolarCheckout(c: Checkout): PolarCheckout {
  return {
    id: c.id,
    url: c.url,
    status: c.status,
    amount: c.amount,
    totalAmount: c.totalAmount,
    taxAmount: c.taxAmount ?? null,
    embedOrigin: c.embedOrigin ?? null,
    customerId: c.customerId ?? null,
    metadata: (c.metadata ?? {}) as Record<string, unknown>,
    expiresAt: c.expiresAt instanceof Date ? c.expiresAt.toISOString() : c.expiresAt ? String(c.expiresAt) : null,
  };
}

export function sdkPolarApi(opts: { accessToken: string; server: "sandbox" | "production" }): PolarApi {
  const polar = new Polar({ accessToken: opts.accessToken, server: opts.server });
  return {
    async createCheckout(req) {
      return toPolarCheckout(await polar.checkouts.create(req));
    },
    async getCheckout(id) {
      return toPolarCheckout(await polar.checkouts.get({ id }));
    },
  };
}

/**
 * The checkout-create request of DESIGN §5.12, exactly (typed against the SDK, so `tsc` confirms every camelCase
 * name): an ad-hoc fixed, tax-inclusive price that overrides the catalog price; the fictional demo customer (locks
 * name and email); the fictional scenario address (skips the address form); no discount codes; the validated
 * `embedOrigin`; our ids in `metadata`. `successUrl` is only for the hosted new-tab variant, never the embed.
 */
export function buildCheckoutCreate(i: {
  productId: string;
  amountCents: number;
  customerId: string | null;
  policy: Pick<PolicyRecord, "address" | "policyholder">;
  embedOrigin: string | null;
  metadata: { paymentId: string; caseId: string; takeoverId: string };
  successUrl?: string | null;
}): CheckoutCreate {
  const a = i.policy.address;
  const req: CheckoutCreate = {
    products: [i.productId],
    prices: {
      [i.productId]: [{ amountType: "fixed", priceAmount: i.amountCents, priceCurrency: "usd", taxBehavior: "inclusive" }],
    },
    customerBillingAddress: { country: "US", line1: a.street, city: a.city, state: `US-${a.state}`, postalCode: a.zip },
    allowDiscountCodes: false,
    metadata: { paymentId: i.metadata.paymentId, caseId: i.metadata.caseId, takeoverId: i.metadata.takeoverId },
  };
  if (i.customerId) req.customerId = i.customerId;
  else req.customerName = `${i.policy.policyholder.firstName} ${i.policy.policyholder.lastName}`;
  if (i.embedOrigin) req.embedOrigin = i.embedOrigin;
  if (i.successUrl) req.successUrl = i.successUrl;
  return req;
}

/**
 * `embedOrigin` (§5.12): the request's Origin if it is in `EMBED_ORIGINS` (or is APP_URL's origin); else APP_URL's
 * origin; else null (then the embed cannot load and the hosted link / Simulate remain).
 */
export function validatedEmbedOrigin(requestOrigin: string | null | undefined, allowed: readonly string[], appUrl: string | null | undefined): string | null {
  const norm = (u: string | null | undefined): string | null => {
    if (!u) return null;
    try {
      const x = new URL(u);
      return x.protocol === "http:" || x.protocol === "https:" ? x.origin : null;
    } catch {
      return null;
    }
  };
  const app = norm(appUrl);
  const req = norm(requestOrigin);
  const allowedSet = new Set(allowed.map(norm).filter((x): x is string => !!x));
  if (app) allowedSet.add(app);
  if (req && allowedSet.has(req)) return req;
  return app;
}
