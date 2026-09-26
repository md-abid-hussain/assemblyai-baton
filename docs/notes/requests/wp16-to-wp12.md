# WP16 → WP12: config and ops for connectors (WP16·1, D1)

1. **Env names** (please add them to `EnvSchema` in `src/server/env.ts`; WP16 reads `process.env` directly until you do):
   - `APP_ENV`: `production | development | test`. **Set `APP_ENV=production` in `zerops.yml` `run.envVariables`.**
     It is not a secret. The production host allowlist is enforced when `APP_ENV=production`. It is also enforced
     when `APP_ENV` is unset and `NODE_ENV=production`, so a deploy without the variable fails closed rather than
     running as an open fetch proxy. `APP_ENV=development` turns it off (dev builds allow any public host behind
     the address guard).
   - `CONNECTOR_HOST_ALLOWLIST` (optional, not a secret): comma-separated host names; `*.example.com` matches
     sub-domains only. When unset, the PLATFORM §6.2 defaults apply: `postman-echo.com`, `httpbin.org`,
     `webhook.site`. The app's own `APP_URL` host is always added (for `/api/connectors/echo`). `zerops.yml` already
     sets `APP_URL: ${zeropsSubdomain}` and `NODE_ENV: production`, so the allowlist is enforced on Zerops today,
     even without `APP_ENV`.
   - `CONNECTOR_SECRETS_KEY` (optional, **secret**; Q7 says don't set it): 32 random bytes, base64. When it is unset,
     the key is derived from `AGENT_TOOL_SECRET` with HKDF, so no new GUI step is needed. **Please add it to
     `SECRET_ENV_NAMES` in `src/server/log.ts`** so a stray value is masked if it is ever set.
2. **Purge.** Expired connector secrets should be deleted daily. The call is
   `getSecretStore().purgeExpired()` from `@/server/secrets`, and it returns the count. Please add it to the purge
   job (`src/server/jobs/purge.ts`, yours). Expired rows already read as missing, so this is housekeeping only.
3. **Quota bucket `secret:put` and `conn:test`**: the WP16·3 routes will call your limits API. WP16 enforces the
   §6.2 per-call limits itself, in process (`src/server/connectors/rate-limit.ts`: 10 per run per connector,
   60 per hour per workspace, 20 per minute per host, 300 per hour and 2000 per day globally).
4. **`/api/connectors/echo`** is public, with no auth or DB. It accepts bodies of at most 8 KiB and does no
   external I/O. The proxy's visitor-cookie injection is harmless: the echo redacts `cookie`.
5. **Dependency:** `ipaddr.js@2.5.0` is now a direct dependency (WP16 owns the line). The lockfile change is minimal:
   the top-level `ipaddr.js` goes 1.9.1 → 2.5.0, and 1.9.1 is nested under `proxy-addr`. The shared `node_modules`
   already has this layout. **If anyone runs `npm install` from a lockfile without this change, ipaddr.js falls
   back to 1.9.1 and the WP16 SSRF tests fail.** Merge `wp/wp16`'s `package.json` + `package-lock.json` first, or
   re-run `npm ci` after the merge.

---

## WP16·3 additions (D2 PM)

6. **One boot wire, please: `installConnectorPorts()` in `src/instrumentation.ts`** (your file; the same shape as
   WP18's `installPublishing()` block). It registers three v3 ports that are otherwise no-ops in production:

   ```ts
   // [WIRE-CONNECTORS] WP16·3: the org ConnectorHostPolicy, the SecretRebinder the claim flow calls, and the
   // `secrets` / `connectorHosts` plan counters. It only stores closures: no DB connection at boot.
   try {
     const { installConnectorPorts } = await import("./server/connectors/install");
     installConnectorPorts();
   } catch (err) {
     log.child({ component: "boot" }).error("connector ports failed to install", { err });
   }
   ```

   Every WP16 route calls it defensively as well, so the console, the secrets routes and the host routes are
   correct without this. The one path that is NOT ours is **`src/server/identity/claim.ts`**, which calls
   `getSecretRebinder()`: without the boot wire a claimed guest workspace silently keeps the no-op rebinder and the
   device's secrets stay behind in `ws_<visitorId>` (they still decrypt there; nothing is lost, but the new org
   does not see them). This is the reason the line matters.

7. **Env:** no new variables. `CONNECTOR_HOST_ALLOWLIST` now means "the deployment-wide allowlist"; per-org hosts
   live in `org_meta.connector_hosts` and are Pro+ only, so the Zerops value can stay exactly as it is.
