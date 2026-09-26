# WP20 → WP22 and WP24: the §8.5 guest interstitial is built; please import it

**From:** WP20·2 · **To:** WP22·1 (API keys) and WP24·1 (Webhooks) · **Blocking:** neither of you, but it saves
you both an hour and stops three copies of one pattern existing.

SAAS §12's v3.1 table assigns WP20 "the two guest upgrade interstitials for API keys and Webhooks (§8.5) —
WP20 owns the pattern, WP22 and WP24 drop it into their pages". This is the drop-in.

## What exists

`src/components/app-shell/account-required.tsx` — a **server component**, no hooks, importable from a page:

```tsx
import { AccountRequired, ACCOUNT_REQUIRED_COPY } from "@/components/app-shell/account-required";

export default async function ApiKeysPage() {
  const principal = await appPrincipal("/app/settings/api-keys");
  const view = await loadYourThing(principal);

  if (view.accountRequired) {
    return (
      <AccountRequired {...ACCOUNT_REQUIRED_COPY.apiKeys}>
        <YourRealPage view={view} />
      </AccountRequired>
    );
  }
  return <YourRealPage view={view} />;
}
```

`ACCOUNT_REQUIRED_COPY.apiKeys` and `.webhooks` carry **§8.5's own sentences** and the correct
`next=<this page>`, so a guest who signs up lands back where they were with the workspace intact (§3.4).
`title`, `body`, `cta` and `next` are all props if you want your own wording — but the spec wrote those two
sentences deliberately, so please change them only for a reason.

## The three things it does that a hand-rolled version usually misses

1. **The children render underneath, dimmed and `inert`.** Not `pointer-events-none`: that leaves every control
   in the tab order and readable to a screen reader as actionable, which is a worse lie than a redirect. React
   19 passes `inert` through as a real attribute. Put your **real** form and your real `curl`/SDK lines in
   there — §8.5's point is that the surface is visibly real *before* signing up, and these two pages are where
   a judge decides whether "real API, real SaaS" is a claim or a product.
2. **Never a redirect and never a bare `E_ACCOUNT_REQUIRED`.** §8.5 forbids both, by name, for exactly these
   two pages. Your read model should return an `accountRequired` flag (mine do) rather than throwing.
3. **The nav keeps your link visible for a guest.** `visibleSettings()` in `src/components/app-shell/nav.ts`
   filters by `can()` and deliberately does **not** hide `accountOnly` rows — so a guest can reach your page
   and meet the card. If you hide the page yourself, you undo that.

## One thing I need from you

Your page owns the `accountRequired` decision, because only you know whether the *plan* or the *account* is
what bites. A guest is the owner of their own guest org, so `can(principal, "apikey:manage")` and
`can(principal, "webhook:read")` are both **true** for them — the guest plan's limits are what actually say no
(`PLANS.guest.limits`). Test for the guest (`principal.isAnonymous || principal.kind === "visitor"`), not for
the permission, or a guest will see your real page and a 402 after the click.

Rendered and asserted in `tests/unit/app/auth-pages.test.tsx` ("the §8.5 account-required card"). Ask me for a
change rather than copying the file; three copies of a pattern is two copies too many.
