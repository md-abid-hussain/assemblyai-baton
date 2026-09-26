"use client";

/**
 * The `BILLING_MODE=simulated` checkout (SAAS §4.7). WP21.
 *
 * It exists so that **billing is demonstrable on a deployment where Polar is not configured, or after K-BILL
 * trips** — and so that nobody has to guess whether what they are looking at is real. The title says it outright,
 * the confirm button writes `org_entitlements {source: "simulated"}`, and every plan badge downstream then reads
 * "Pro · simulated". Limits, API keys and webhooks behave identically, because they read the same row.
 *
 * There is deliberately no card field of any kind. A fake card form on a page titled "simulated" would teach the
 * wrong habit and would be the one screenshot in the demo that looks like a lie.
 */
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

const PLAN_NAMES: Record<string, string> = { pro: "Pro", business: "Business" };

export function SimulatedCheckout({ plan }: { plan: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const name = PLAN_NAMES[plan] ?? plan;
  const known = plan === "pro" || plan === "business";

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/app/billing/simulated", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ plan }),
      });
      const body: unknown = await res.json().catch(() => ({}));
      if (!res.ok) {
        const err = (body as { error?: { message?: string } }).error;
        throw new Error(err?.message ?? "We could not apply the simulated plan.");
      }
      window.location.assign("/app/settings/billing");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <Card data-testid="simulated-checkout">
      <CardHeader>
        <CardTitle>Simulated checkout · billing is not configured on this deployment</CardTitle>
        <CardDescription>
          No payment provider is reachable here, so this page stands in for one. Confirming applies the{" "}
          {name} plan immediately and labels it <span className="font-medium">simulated</span> everywhere. No card
          is asked for, and no money moves — in this mode there is nothing that could.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {known ? null : (
          <p role="alert" className="text-sm text-destructive">
            &ldquo;{plan}&rdquo; is not a plan you can pick. Go back and choose Pro or Business.
          </p>
        )}
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <div className="flex flex-wrap gap-3">
          <Button onClick={() => void confirm()} disabled={busy || !known}>
            {busy ? "Applying…" : `Confirm ${name} (simulated)`}
          </Button>
          <Button variant="outline" asChild>
            <a href="/app/settings/billing">Cancel</a>
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
