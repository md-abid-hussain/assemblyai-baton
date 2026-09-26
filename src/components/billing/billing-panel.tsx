"use client";

/**
 * The Billing page's body (SAAS §4.6, §4.7, §8.4). WP21.
 *
 * It is a client component on purpose. §4.6 step 4 is a *polling* requirement — "Confirming your subscription…",
 * every 1 s for at most 20 s — and that is the whole demo beat: the judge comes back from sandbox.polar.sh and
 * the page has to turn into "Pro · Test mode" while they watch, without a manual refresh. A server component
 * would have to be reloaded by hand at exactly the wrong moment.
 *
 * It also means this page renders before WP20's app shell exists, which is what lets WP21·1 and WP20·2 run in
 * the same slot without either blocking the other.
 *
 * Every number on the page comes from `GET /api/app/billing`, which derives them from `PLANS` + the org's
 * overrides — so the page can never disagree with the limit that actually gets enforced.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { CancelBanner, formatDay, PlanBadge, type PlanSource } from "@/components/billing/plan-notice";

/** Mirrors `BillingView` in `src/server/billing/routes.ts`; the client never imports a server module. */
export interface BillingViewData {
  mode: "polar" | "simulated";
  orgId: string;
  plan: string;
  planName: string;
  status: string;
  source: PlanSource;
  badge: string;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  syncedAt: string | null;
  limits: Record<string, unknown>;
  upgrades: { plan: "pro" | "business"; name: string; priceUsdMonthly: number | null }[];
  canManage: boolean;
  unavailable: boolean;
}

/** §4.6 step 4: poll the sync every second, for at most twenty. */
export const CONFIRM_POLL_MS = 1000;
export const CONFIRM_TIMEOUT_MS = 20_000;

const PAID = new Set(["pro", "business"]);

async function fetchState(checkoutId: string | null): Promise<BillingViewData> {
  const qs = checkoutId ? `?checkout_id=${encodeURIComponent(checkoutId)}` : "";
  const res = await fetch(`/api/app/billing${qs}`, { headers: { accept: "application/json" }, cache: "no-store" });
  const body: unknown = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = (body as { error?: { message?: string } }).error;
    throw new Error(err?.message ?? `Billing is unavailable (${res.status}).`);
  }
  return body as BillingViewData;
}

export function BillingPanel({ checkoutId = null }: { checkoutId?: string | null }) {
  const [view, setView] = useState<BillingViewData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  /** `true` while the §4.6 step-4 confirmation poll is running. */
  const [confirming, setConfirming] = useState(checkoutId !== null);
  const startedAt = useRef<number>(Date.now());

  const load = useCallback(async (id: string | null) => {
    try {
      const next = await fetchState(id);
      setView(next);
      setError(null);
      return next;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return null;
    }
  }, []);

  // First load, and then the confirmation poll when we came back from a checkout.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const tick = async () => {
      const next = await load(checkoutId);
      if (cancelled) return;
      if (checkoutId === null) return;
      // Done as soon as the plan is paid, or when the twenty seconds are up (the page still renders the truth).
      if (next && PAID.has(next.plan)) {
        setConfirming(false);
        return;
      }
      if (Date.now() - startedAt.current >= CONFIRM_TIMEOUT_MS) {
        setConfirming(false);
        return;
      }
      timer = setTimeout(() => void tick(), CONFIRM_POLL_MS);
    };

    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [checkoutId, load]);

  const upgrade = async (plan: "pro" | "business") => {
    setBusy(plan);
    setError(null);
    try {
      const res = await fetch("/api/app/billing/checkout", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ plan }),
      });
      const body: unknown = await res.json().catch(() => ({}));
      if (!res.ok) {
        const err = (body as { error?: { message?: string } }).error;
        throw new Error(err?.message ?? "We could not start the checkout.");
      }
      const url = (body as { url?: string }).url;
      if (!url) throw new Error("We could not start the checkout.");
      window.location.assign(url);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(null);
    }
  };

  const openPortal = async () => {
    setBusy("portal");
    setError(null);
    try {
      // The Polar plugin's own endpoint. It answers `{url}` and is not one of the §3.8 blocked client paths.
      const res = await fetch("/api/auth/customer/portal", { headers: { accept: "application/json" } });
      const body: unknown = await res.json().catch(() => ({}));
      const url = (body as { url?: string }).url;
      if (!res.ok || !url) throw new Error("The subscription portal is unavailable right now.");
      window.location.assign(url);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(null);
    }
  };

  if (!view) {
    return (
      <p className="text-sm text-muted-foreground" role="status">
        {error ?? "Loading your plan…"}
      </p>
    );
  }

  const paid = PAID.has(view.plan);

  return (
    <div className="flex flex-col gap-6" data-testid="billing-panel">
      {confirming ? (
        <p className="text-sm text-muted-foreground" role="status" data-testid="confirming">
          Confirming your subscription…
        </p>
      ) : null}

      {view.unavailable ? (
        <div role="status" className="rounded-lg border border-amber-300/60 bg-amber-50 p-4 text-sm dark:bg-amber-950/30">
          We could not reach billing just now, so this is your last known plan. Nothing has changed.
        </div>
      ) : null}

      {view.cancelAtPeriodEnd ? <CancelBanner plan={view.plan} currentPeriodEnd={view.currentPeriodEnd} /> : null}

      <Card>
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center gap-3">
            <span>Your plan</span>
            <PlanBadge plan={view.plan} source={view.source} />
          </CardTitle>
          <CardDescription>
            {view.mode === "simulated"
              ? "Billing is not configured on this deployment, so checkout is simulated. Every limit below is real."
              : "Everything runs in the Polar sandbox. No real money moves, and the card 4242 4242 4242 4242 works."}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <dl className="grid gap-x-8 gap-y-2 text-sm sm:grid-cols-2">
            <Row label="Plan" value={view.planName} />
            <Row label="Status" value={view.status} />
            {view.currentPeriodEnd ? <Row label="Renews" value={formatDay(view.currentPeriodEnd) ?? "—"} /> : null}
            <Row label="Billing mode" value={view.mode === "polar" ? "Polar sandbox (test mode)" : "Simulated"} />
          </dl>

          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}

          {view.canManage ? (
            <div className="flex flex-wrap gap-3">
              {view.upgrades.map((u) => (
                <Button key={u.plan} onClick={() => void upgrade(u.plan)} disabled={busy !== null}>
                  {busy === u.plan ? "Opening checkout…" : `Upgrade to ${u.name}`}
                  {u.priceUsdMonthly !== null ? (
                    <span className="opacity-80">· ${u.priceUsdMonthly}/mo</span>
                  ) : null}
                </Button>
              ))}
              {paid && view.mode === "polar" ? (
                <Button variant="outline" onClick={() => void openPortal()} disabled={busy !== null}>
                  {busy === "portal" ? "Opening…" : "Manage subscription"}
                </Button>
              ) : null}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">Only an owner can change this organization&apos;s plan.</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4 sm:block">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-medium capitalize">{value}</dd>
    </div>
  );
}
