/**
 * `plan-notice.tsx` — the small, reusable plan surfaces (SAAS §4.2, §4.6, §4.7). WP21.
 *
 * Four components, all pure and all server-renderable, so any page can show a plan fact without importing the
 * billing layer:
 *
 *  - `<PlanBadge>` — "Pro · Test mode (Polar sandbox) — no real money" / "Pro · simulated". **The badge is the
 *    proof on screen** that the upgrade is real and that no money moved, so its wording lives in exactly one
 *    place (`badgeFor`, mirrored here for the client) and is never re-phrased per page.
 *  - `<PlanLimitNotice>` — what a $0 action over a count limit shows: "Your Free plan includes 5 relays.
 *    Upgrade, or archive one." (§4.2, first bullet).
 *  - `<UpgradeCard>` — the §8.5 rule for account-only surfaces: show the real surface, disable the action, offer
 *    the 10-second account. Used by the API keys and Webhooks pages when a guest arrives.
 *  - `<CancelBanner>` — "Pro until <date>, then Free" (§4.6).
 *
 * None of these import `src/server/**`; they take plain data.
 */
import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export const BILLING_PATH = "/app/settings/billing";

export type PlanSource = "default" | "polar" | "simulated" | "admin";

const PLAN_NAMES: Record<string, string> = {
  guest: "Guest",
  free: "Free",
  pro: "Pro",
  business: "Business",
};

/**
 * The badge text. Kept in step with `badgeFor()` in `src/server/billing/routes.ts` by
 * `tests/unit/server/billing/badge.test.ts`, which asserts the two agree for every plan × source pair — a
 * duplicated string is fine; a duplicated string that can drift is not.
 */
export function planBadgeText(plan: string, source: PlanSource): string {
  const name = PLAN_NAMES[plan] ?? plan;
  if (source === "simulated") return `${name} · simulated`;
  if (source === "polar") return `${name} · Test mode (Polar sandbox) — no real money`;
  return name;
}

export function PlanBadge({
  plan,
  source,
  className,
}: {
  plan: string;
  source: PlanSource;
  className?: string;
}) {
  const paid = plan === "pro" || plan === "business";
  return (
    <Badge
      variant={paid ? "default" : "secondary"}
      className={cn("font-medium", className)}
      data-testid="plan-badge"
      data-plan={plan}
      data-source={source}
    >
      {planBadgeText(plan, source)}
    </Badge>
  );
}

/**
 * The 402 a $0 create gets (§4.2). `used`/`limit`/`plan` come straight from the error's `extra.limit`, so the
 * notice states the real numbers rather than a generic "limit reached".
 */
export function PlanLimitNotice({
  plan,
  noun,
  limit,
  action = "Upgrade, or remove one.",
  className,
}: {
  plan: string;
  noun: string;
  limit: number;
  action?: string;
  className?: string;
}) {
  return (
    <div
      role="status"
      data-testid="plan-limit-notice"
      className={cn("rounded-lg border border-amber-300/60 bg-amber-50 p-4 text-sm dark:bg-amber-950/30", className)}
    >
      <p className="text-foreground">
        Your <span className="font-medium">{PLAN_NAMES[plan] ?? plan}</span> plan includes {limit} {noun}. {action}
      </p>
      <Button asChild size="sm" className="mt-3">
        <Link href={BILLING_PATH}>See plans</Link>
      </Button>
    </div>
  );
}

/**
 * §8.5: the account wall that sells rather than refuses. The caller renders the real surface underneath,
 * disabled — this component is only the card on top of it.
 */
export function UpgradeCard({
  title,
  body,
  cta = "Create your free account",
  next,
  className,
}: {
  title: string;
  body: string;
  cta?: string;
  /** The page to come back to, so the workspace carries over (§3.4). */
  next: string;
  className?: string;
}) {
  return (
    <div
      data-testid="upgrade-card"
      className={cn("rounded-lg border bg-card p-5 shadow-sm", className)}
    >
      <h3 className="text-base font-semibold text-card-foreground">{title}</h3>
      <p className="mt-1 text-sm text-muted-foreground">{body}</p>
      <Button asChild className="mt-4">
        <Link href={`/sign-up?next=${encodeURIComponent(next)}`}>{cta}</Link>
      </Button>
    </div>
  );
}

/** "Pro until 3 Oct 2026, then Free." (§4.6). Rendered only when `cancelAtPeriodEnd` is true. */
export function CancelBanner({
  plan,
  currentPeriodEnd,
  className,
}: {
  plan: string;
  currentPeriodEnd: string | null;
  className?: string;
}) {
  const name = PLAN_NAMES[plan] ?? plan;
  const when = formatDay(currentPeriodEnd);
  return (
    <div
      role="status"
      data-testid="cancel-banner"
      className={cn("rounded-lg border border-amber-300/60 bg-amber-50 p-4 text-sm dark:bg-amber-950/30", className)}
    >
      {when
        ? `${name} until ${when}, then Free. Resume any time from Manage subscription.`
        : `${name} until the end of the current period, then Free. Resume any time from Manage subscription.`}
    </div>
  );
}

/** A stable, locale-independent day ("3 Oct 2026"): a server/client mismatch here would hydrate-warn. */
export function formatDay(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${d.getUTCDate()} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}
