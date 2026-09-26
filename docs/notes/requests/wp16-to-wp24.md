# WP16 → WP24: the guarded client, and the one overlap to avoid

## 1. `publicHttpsPost` is ready (SAAS §7.4)

```ts
import { publicHttpsPost } from "@/server/connectors";   // or "@/server/connectors/public-post"

const r = await publicHttpsPost(endpoint.url, {
  headers: { "webhook-id": id, "webhook-timestamp": ts, "webhook-signature": sig },
  body: rawBody,            // the EXACT bytes you signed (string or Buffer); Content-Type/Length are set for you
  timeoutMs: 5000,          // default WEBHOOK_TIMEOUT_MS
});
// { ok, status, errorCode, message, bodyText, ms, address }
```

What it guarantees, because it shares `sendGuarded` with `http_action` (one guarded client in the app, SAAS §10.3):
`https:` + port 443 only, no userinfo, no `localhost`/single-label host; c-ares resolution inside 1.5 s with every
answer checked against the `ipaddr.js` unicast allowlist (incl. the embedded IPv4 forms); the chosen address is
**pinned** for the connection (`autoSelectFamily:false`, fresh agent, no pooled socket), so DNS rebinding cannot
happen; no redirects; no `Accept-Encoding` and a compressed body is refused; one deadline across connect, TLS and
body; an 8 KiB response cap. It never throws — a failure is `{ok:false, errorCode:"E_CONN_*"}`, which is what your
retry schedule wants.

**It deliberately does NOT apply the §5.6 connector host policy.** A webhook endpoint is the customer's own URL;
the allowlist exists to stop a *blueprint* turning us into a fetch proxy. Please do not add a host check on top —
the address guard is the security boundary here, and `tests/unit/server/connectors/public-post.test.ts` pins the
"delivers to an unlisted host on the public deployment" behaviour.

The test inbox (`<APP_URL>/api/webhook-inbox/*`) is your own origin, which the address guard allows on Zerops (a
public address) but not locally (127.0.0.1) — that is what `WEBHOOK_INBOX_LOOPBACK=1` is for.

## 2. Do not re-send the `completion_webhook`

PLATFORM §6.1's `completion_webhook` is a **blueprint connector**, not a webhook endpoint: WP16 sends it from
`src/server/connectors/completion-webhook.ts` with the C2 `X-Changeover-*` signature, and the §5.6 host policy
applies to it because its URL comes from a blueprint. Your `run.completed` domain event is the separate, durable
channel with Standard Webhooks signing. A relay can legitimately have both; they are different bodies to different
URLs, and neither should grow a copy of the other.

## 3. Secrets

Webhook secrets use the same crypto (`src/server/secrets/crypto.ts`: AES-256-GCM, `sealSecret`/`openSecret`, the
keyring from `CONNECTOR_SECRETS_KEY` or HKDF(`AGENT_TOOL_SECRET`)). Call `secretAad(orgId, endpointId)` for your
AAD, as SAAS §10.2 says, and register your values with `registerSecrets(value)` from `@/server/log` so a stray log
line masks them. Please do not reuse `connector_secrets` rows: `SecretStore.list` is the Connectors tab's list.
