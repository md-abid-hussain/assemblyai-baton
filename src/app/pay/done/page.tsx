import type { Metadata } from "next";

import { reconcileCheckout } from "@/server/payments/done";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Payment received", robots: { index: false, follow: false } };

/**
 * `/pay/done` (DESIGN §5.12 "Hosted fallback"): the success URL of the new-tab checkout. It asks the server to
 * reconcile with Polar, then tells the judge to go back to the Baton tab (where the phone and the agent continue).
 */
export default async function PayDonePage({ searchParams }: { searchParams: Promise<{ checkout_id?: string }> }) {
  const { checkout_id } = await searchParams;
  const status = await reconcileCheckout(checkout_id);
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-3 p-6 text-center">
      <span className="flex size-14 items-center justify-center rounded-full bg-success/15 text-3xl text-success" aria-hidden>
        ✓
      </span>
      <h1 className="text-xl font-semibold">Payment received: return to the Baton tab</h1>
      <p className="text-sm text-muted-foreground">
        {status === "succeeded"
          ? "Polar confirmed the sandbox payment. The agent picks it up on the call."
          : "Polar is confirming the sandbox payment. The Baton tab updates on its own; you can close this tab."}
      </p>
      <p className="text-xs text-muted-foreground">Polar sandbox · test card · no real money moved</p>
    </main>
  );
}
