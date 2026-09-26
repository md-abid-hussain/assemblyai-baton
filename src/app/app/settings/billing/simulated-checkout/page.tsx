import type { Metadata } from "next";

import { SimulatedCheckout } from "@/components/billing/simulated-checkout";
import { appPrincipal } from "@/server/read-models/app-guard";

/** `BILLING_MODE=simulated`'s stand-in for the provider's checkout (SAAS §4.7). WP21. */
export const metadata: Metadata = {
  title: "Simulated checkout · Changeover",
  description: "Billing is not configured on this deployment, so this checkout is simulated.",
};

export const dynamic = "force-dynamic";

export default async function SimulatedCheckoutPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const raw = params.plan;
  const plan = typeof raw === "string" ? raw : "pro";

  // Upgrading is an act on an org: resolve the principal before showing a checkout, simulated or not.
  await appPrincipal("/app/settings/billing/simulated-checkout");

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-col gap-6 p-6">
      <SimulatedCheckout plan={plan} />
    </main>
  );
}
