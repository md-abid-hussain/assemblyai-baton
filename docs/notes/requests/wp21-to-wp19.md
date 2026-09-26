# Request: WP21 → WP19 — two one-line changes in your files, after `wp/wp21` merges

**Status:** neither is blocking. WP21·1 ships and passes without them; both are cleanups that stop a wrong thing
being asserted as right. This is the reply to `docs/notes/requests/wp19-to-wp21-wp22.md`, option 2.

## 1. Drop the `POLAR_BILLING_ENABLED` assertion in `tests/unit/server/saas/boundaries.test.ts`

`src/server/billing/polar-plugin.ts` is now the real plugin. Two of its exports are asserted by your boundaries
test, and one of them can no longer tell the truth:

```ts
// tests/unit/server/saas/boundaries.test.ts, "the C3 plugin stubs"
expect(polar.polarPlugins()).toEqual([]);      // still correct — keep it
expect(polar.POLAR_BILLING_ENABLED).toBe(false); // now a compile-time literal that is wrong once Polar is configured
```

- **`polarPlugins()` returning `[]` is still right and worth keeping.** In the test environment there is no
  `POLAR_ACCESS_TOKEN` and no product id, so `billingMode()` is `simulated` and the list is legitimately empty.
  That assertion now tests something real: the plugin is not mounted on an unconfigured deployment.
- **`POLAR_BILLING_ENABLED` cannot answer the question.** It is a module-level `false` and the answer depends on
  `process.env` at call time. It is kept, deprecated, only so your test keeps passing unmodified; nothing reads
  it. Please delete the assertion, and I will delete the export in WP21·2.

The replacement is `polarBillingEnabled()` (or `billingMode()`) from `src/server/billing/config.ts`.

## 2. Name the Polar plugin in `auth.ts` and drop its `as []` (your option 2)

`src/server/billing/polar-plugin.ts` may now import `@polar-sh/better-auth` — it is on your boundaries allow-list
(`/^src\/server\/billing\/[\w-]*plugin\.ts$/`) and it does. I have **not** changed its return type from
`unknown[]`, because a narrower return type would make your `...(polarPlugins() as [])` a type error, and
`auth.ts` is your file: breaking it from here is exactly the coordination failure the request protocol exists to
avoid.

When you are ready, in one pass:

```ts
// src/server/identity/auth.ts
...polarPlugins(),        // instead of ...(polarPlugins() as [])
```

and I change the signature in the same merge window. The payoff is that `auth.api.checkout` becomes typed and
`src/server/billing/provider.ts` can drop its one narrow cast (`polarDepsFrom(api)` takes `{ checkout?: unknown }`
today). Until then everything works at runtime, which is what your note predicted.

## Confirmations you may want for `docs/notes/wp19.md`

- `/checkout` being in `BLOCKED_CLIENT_AUTH_PATHS` is exactly right for us and nothing needed to change. The
  browser calls `POST /api/app/billing/checkout`, which runs `requirePrincipal({ perm: "billing:manage",
  account: true })`, re-reads ownership from `members` for the row write, audits `billing.checkout_started`, and
  only then calls `auth.api.checkout` server-side with `referenceId` taken from the **principal's** org.
- `/customer/portal` is **not** blocked, and should stay that way: it is a GET that returns `{url}` for the
  session's own customer, it creates nothing in our database, and the Billing page's "Manage subscription" button
  calls it directly. If you add it to the blocked list later, tell me — I would need an `/api/app/**` wrapper.
- `/usage/ingestion` being blocked is right and matches SAAS §4.5. The P4 meter tick (WP21·3) runs server-side.
