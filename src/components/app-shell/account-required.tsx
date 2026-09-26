/**
 * The §8.5 "show the real surface, disable the action, offer the 10-second account" card. WP20·2.
 *
 * SAAS §8.5 names three places this pattern has to appear — API keys (WP22), Webhooks (WP24) and Members →
 * Invite (WP20) — and then says "the same pattern covers ... any future account-only page". Three copies of a
 * pattern is two copies too many, so it is one component in WP20's shared directory and the other two WPs
 * import it. **Nothing about it is WP20-specific**; if a page needs its own sentence, the sentence is a prop.
 *
 * **It is a card, not a gate.** The children render underneath it, dimmed and inert, because the point of the
 * pattern is that a judge can see the real surface before signing up. `inert` is the correct primitive here:
 * `pointer-events-none` alone still leaves every control in the tab order and readable to a screen reader as
 * actionable, which is a worse lie than a redirect. React 19 passes `inert` through as a real attribute.
 *
 * The button always carries `?next=<this page>`, so §3.4's carry-over lands the new account back on the page
 * they wanted with the guest workspace intact.
 */
import Link from "next/link";
import type * as React from "react";

import { cn } from "@/lib/utils";

export interface AccountRequiredProps {
  /** The bold sentence. SAAS §8.5 writes it in the second person and names the thing being unlocked. */
  title: React.ReactNode;
  /** The reassurance: how long it takes, that no card is needed, that the workspace comes along. */
  body: React.ReactNode;
  /** Where sign-up returns to. A same-origin path; `SignUpPage` re-validates it with `safeNextPath`. */
  next: string;
  cta?: string;
  /** The real surface, rendered underneath: visible, legible, and not operable. */
  children?: React.ReactNode;
  className?: string;
}

export function AccountRequired({
  title,
  body,
  next,
  cta = "Create your free account",
  children,
  className,
}: AccountRequiredProps) {
  return (
    <div className={cn("space-y-4", className)}>
      <div className="border-primary/30 bg-card rounded-xl border p-4 sm:p-5">
        <p className="text-sm font-semibold text-balance">{title}</p>
        <p className="text-muted-foreground mt-1 max-w-prose text-sm text-pretty">{body}</p>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <Link
            href={`/sign-up?next=${encodeURIComponent(next)}`}
            className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex h-9 items-center rounded-md px-4 text-sm font-medium transition-colors"
          >
            {cta}
          </Link>
          <Link
            href={`/sign-in?next=${encodeURIComponent(next)}`}
            className="text-muted-foreground hover:text-foreground text-sm font-medium underline underline-offset-4"
          >
            I already have one
          </Link>
        </div>
      </div>

      {children ? (
        <div inert aria-hidden="true" className="pointer-events-none select-none opacity-55">
          {children}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The two interstitials SAAS §8.5 writes out in full, ready for WP22's and WP24's pages to drop in.
 *
 * S§12 assigns WP20 "the pattern"; these are the pattern *plus the spec's own copy*, so neither of those two
 * WPs has to paraphrase a sentence that was written deliberately. Both pages are `account` in §8.1, so a guest
 * reaching them is the expected case rather than an edge one — and §8.5 is explicit that the answer is never a
 * redirect and never a bare `E_ACCOUNT_REQUIRED`.
 *
 * Usage: `<AccountRequired {...ACCOUNT_REQUIRED_COPY.apiKeys}>{theRealPage}</AccountRequired>`.
 */
export const ACCOUNT_REQUIRED_COPY = Object.freeze({
  apiKeys: Object.freeze({
    title: "Create your free account to unlock API keys",
    body: "10 s, no card, and your workspace comes with you.",
    next: "/app/settings/api-keys",
  }),
  webhooks: Object.freeze({
    title: "Create your free account to unlock webhooks",
    body: "10 s, no card. Then send yourself a signed run.completed in one click.",
    next: "/app/settings/webhooks",
  }),
}) satisfies Readonly<Record<string, Pick<AccountRequiredProps, "title" | "body" | "next">>>;
