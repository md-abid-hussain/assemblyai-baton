import "server-only";

import type { PaymentStatus } from "../../core/contracts/case";
import type { PaymentProvider } from "../../core/contracts/services";
import { buildCheckoutCreate, validatedEmbedOrigin, type PolarApi } from "../polar/client";
import { fromPolarCheckoutStatus } from "./machine";

type CreateInput = Parameters<PaymentProvider["createCheckout"]>[0];
type CreateOutput = Awaited<ReturnType<PaymentProvider["createCheckout"]>>;

export interface PolarProviderConfig {
  productId: string;
  /** scenarioId → Polar sandbox customer id (`POLAR_DEMO_CUSTOMERS`, printed by scripts/polar/setup.ts). */
  demoCustomers: Readonly<Record<string, string>>;
  embedOrigins: readonly string[];
  appUrl: string | null;
}

/** `PaymentProvider` on Polar (sandbox). Stateless: the payment service owns persistence, retries and fallback. */
export class PolarPaymentProvider implements PaymentProvider {
  readonly kind = "polar" as const;
  constructor(
    private readonly api: PolarApi,
    private readonly cfg: PolarProviderConfig,
  ) {}

  async createCheckout(i: CreateInput): Promise<CreateOutput> {
    const embedOrigin = validatedEmbedOrigin(i.origin, this.cfg.embedOrigins, this.cfg.appUrl);
    const co = await this.api.createCheckout(
      buildCheckoutCreate({
        productId: this.cfg.productId,
        amountCents: i.amountCents,
        customerId: this.cfg.demoCustomers[i.scenarioId] ?? null,
        policy: i.policy,
        embedOrigin,
        metadata: { paymentId: i.paymentId, caseId: i.caseId, takeoverId: i.takeoverId },
      }),
    );
    return {
      checkoutId: co.id,
      url: co.url,
      embed: { url: co.url, origin: polarOriginOf(co.url) },
      totalAmountCents: co.totalAmount,
      taxAmountCents: co.taxAmount,
    };
  }

  async getStatus(checkoutId: string): Promise<{ status: PaymentStatus; totalAmountCents: number | null }> {
    const co = await this.api.getCheckout(checkoutId);
    return { status: fromPolarCheckoutStatus(co.status) ?? "open", totalAmountCents: co.totalAmount };
  }
}

/** `PaymentProvider` for `PAYMENTS_MODE=mock` and the Polar-unavailable fallback: no checkout, only Simulate. */
export class MockPaymentProvider implements PaymentProvider {
  readonly kind = "mock" as const;
  async createCheckout(i: CreateInput): Promise<CreateOutput> {
    return { checkoutId: null, url: null, embed: null, totalAmountCents: i.amountCents, taxAmountCents: 0 };
  }
  async getStatus(): Promise<{ status: PaymentStatus; totalAmountCents: number | null }> {
    // A mock payment has no remote state; the payment row is the truth.
    return { status: "open", totalAmountCents: null };
  }
}

/** The origin the embedded checkout's messages come from (the checkout URL's origin). */
export function polarOriginOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "https://sandbox.polar.sh";
  }
}
