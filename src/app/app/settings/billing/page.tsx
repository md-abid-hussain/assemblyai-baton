import type { Metadata } from "next";

import { BillingPanel } from "@/components/billing/billing-panel";
import { appPrincipal } from "@/server/read-models/app-guard";

/**
 * Settings → Billing & plan (SAAS §8.4, §4.6). WP21.
 *
 * A thin server shell around a client panel: §4.6 step 4 polls the sync for up to 20 s after the checkout
 * return, which has to happen in the browser. The shell reads `?checkout_id=` and hands it down; the panel does
 * everything else through `/api/app/billing`, so this page has no server-side billing dependency at all and
 * renders before WP20's app shell exists.
 */
export const metadata: Metadata = {
  title: "Billing & plan · Changeover",
  description: "Your plan, limits and subscription. Everything runs in the Polar sandbox: no real money moves.",
};

export const dynamic = "force-dynamic";

export default async function BillingSettingsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const raw = params.checkout_id;
  const checkoutId = typeof raw === "string" && raw ? raw : null;

  // G3: a plan belongs to an org, so the page needs a principal even though `/api/app/billing` does the
  // reading (TASKS-v3 §2 rule 13). A session-less visitor goes to `/start`, not to an empty billing shell.
  await appPrincipal("/app/settings/billing");

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Billing &amp; plan</h1>
        <p className="text-sm text-muted-foreground">
          $0.30 per AI-finished minute. The low-code studio, API, SDK and CLI are included on every plan.
        </p>
      </header>
      <BillingPanel checkoutId={checkoutId} />
    </main>
  );
}
