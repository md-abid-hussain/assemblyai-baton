/**
 * client/fixtures/phone-client.ts - a no-network `PaymentsClient` (WP6 `src/client/tools/payments.ts`) for the /dev/ui
 * `phone=wp6` harness: it lets WP6's real MockPhone run inside a fixture-driven console (screenshots, the Playwright
 * pass over the pay sheet) without a case, a takeover or the payment routes.
 *
 * The view is built from the fixture's case state (the amounts, the e-sign summary). E-sign and Simulate succeed after
 * a short delay; Simulate then reports `succeeded` with `status_source=mock`, like route #17. Dev only: the live
 * console always uses WP6's HTTP client.
 */
import "client-only";

import type { CaseState, FieldId, PaymentStatus, PolicyRecord } from "@/core/contracts/case";
import type { PaymentViewExt } from "@/core/contracts/ext/wp6-payments";

import type { PaymentsClient } from "../tools/payments";

export const FIXTURE_PAYMENT_ID = "pay_fixture_1";
export const FIXTURE_TAKEOVER_TOKEN = "fixture";

export interface FixturePhoneSource {
  caseState(): CaseState | null;
  policy(): PolicyRecord | null;
}

const display = (cs: CaseState | null, id: FieldId): string | null => cs?.fields[id]?.display ?? null;
const usdToCents = (v: string | null): number | null => {
  const n = v ? Number(v.replace(/[^0-9.]/g, "")) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : null;
};

export function createFixturePaymentsClient(src: FixturePhoneSource, o: { delayMs?: number } = {}): PaymentsClient {
  const delay = () => new Promise<void>((r) => setTimeout(r, o.delayMs ?? 400));
  let status: PaymentStatus = "created";
  let simulated = false;
  let esignedAt: string | null = null;

  const view = (id: string): PaymentViewExt => {
    const cs = src.caseState();
    const policy = src.policy();
    const amountCents = cs?.payment?.amountCents ?? usdToCents(display(cs, "amount_due_today_usd")) ?? 0;
    const monthly = display(cs, "premium_new_monthly_usd");
    return {
      id,
      status,
      statusSource: status === "succeeded" ? "mock" : null,
      amountCents,
      totalAmountCents: amountCents,
      provider: "mock",
      simulated,
      embed: null,
      updatedAt: new Date().toISOString(),
      label: simulated ? "Simulated" : "Simulated payment (fixture)",
      esignedAt,
      ...(policy
        ? {
            summary: {
              policyNumber: policy.policyNumber,
              agencyName: policy.agencyName,
              policyholderName: `${policy.policyholder.firstName} ${policy.policyholder.lastName}`,
              phoneLast4: policy.phoneOnFileLast4,
              driver: display(cs, "driver_full_name"),
              relation: display(cs, "driver_relation"),
              vehicle: display(cs, "vehicle_assignment"),
              effectiveDate: display(cs, "effective_date"),
              monthlyUsd: monthly ? monthly.replace(/[^0-9.]/g, "") || null : null,
              dueTodayUsd: amountCents ? (amountCents / 100).toFixed(2) : null,
            },
          }
        : {}),
    };
  };

  return {
    async get(id) {
      return view(id);
    },
    async esign() {
      await delay();
      esignedAt = new Date().toISOString();
      return { ok: true, signedAt: esignedAt };
    },
    async simulate() {
      await delay();
      status = "succeeded";
      simulated = true;
      return { ok: true };
    },
    async timeout() {
      if (status !== "succeeded" && status !== "failed" && status !== "expired") status = "timeout";
      return { ok: true, status };
    },
  };
}
