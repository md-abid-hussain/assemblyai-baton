# WP19 → WP21 and WP22: your plugin's endpoints will not be on `auth.api`'s type (one-line fix, read before you wire)

**Status:** applies from C3b. Nothing to do now; this is the thing that will confuse you for twenty minutes later.

## The situation

`src/server/identity/auth.ts` builds the one `betterAuth()` instance and spreads your two stubs into the plugin
array:

```ts
plugins: [
  anonymous({ … }),
  organization({ … }),
  ...(apiKeyPlugins() as []),   // WP22, src/server/api-v1/keys-plugin.ts
  ...(polarPlugins()  as []),   // WP21, src/server/billing/polar-plugin.ts
  nextCookies(),
],
```

Both stubs are declared `unknown[]`, because neither file may import `better-auth` before its own unit runs.
Spreading an `unknown[]` into that array widens its element type to `unknown`, and Better Auth infers the whole of
`auth.api` **from the array type** — so it does not merely lose your two entries, it collapses inference for
everything: `auth.api.signInAnonymous` and `session.activeOrganizationId` disappear too. That was five of the nine
typecheck errors WP19·2 started with. Casting the spread to the empty tuple keeps the literal tuple's inference
intact while the runtime array still receives whatever your function returns.

## The cost, which lands on you

The **runtime** behaviour is right: your plugin is in the array and its endpoints are served. Only the **type** is
narrow, so:

- `auth.api.createApiKey(…)` / `auth.api.checkout(…)` will not type-check from server code;
- `auth.$Infer` will not know your plugin's session or user fields.

## What to do

Pick whichever fits:

1. **Cast at the call site** — fine for one or two calls:
   ```ts
   const api = requireAuth().api as typeof requireAuth extends never ? never : Record<string, (...a: never[]) => Promise<unknown>>;
   ```
   or, more simply, a local interface describing just the endpoint you call.
2. **Ask WP19 to name your plugin in `auth.ts`** — a one-line request file here. Once your plugin file can import
   `better-auth` (it can, from C3b: both `*-plugin.ts` files are on the boundaries allow-list), change its return
   type from `unknown[]` to a real tuple and I will drop the `as []` for it. This is the clean end state and it
   costs one line each.

Option 2 is preferable once you are actually wiring the plugin. The stubs were deliberately typed `unknown[]` so
WP19·2 could mount Better Auth before either of you existed — that job is done.

## Two other things you will want

- **WP22:** `apikeys` is **not** in `getAuthTables()` for our config, so `0002_saas` does not create it. When you
  add `@better-auth/api-key`, send a request file here and WP19 adds the table in `0004` (TASKS-v3 §2 rule 14 — no
  second WP generates a migration). Also note `advanced.database.generateId` is ours and keys on the **singular**
  model name; `apikey` is already mapped to the `akr_` row-id prefix in `src/server/identity/ids.ts`.
- **WP21:** `/checkout` is in `BLOCKED_CLIENT_AUTH_PATHS` (SAAS §3.8), so the browser cannot call it through the
  catch-all — it must go through `/api/app/**`, which runs `requirePrincipal` + `can()` + the entitlement check and
  writes the audit row. Server-side `auth.api.*` calls are unaffected by that filter.
