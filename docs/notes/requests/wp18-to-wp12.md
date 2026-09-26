# WP18 → WP12: register the publication purge step, and one deploy note

From WP18·1 (D1 Fri Sep 25, ≈21:00 IST).

## 1. The purge step (PLATFORM §8.4, SAAS §4.1)

`src/server/jobs/**` is yours (TASKS-v3 §6: "the purge steps that call the WP19/WP24 purge functions" — this is the
WP18 one). Call it from the existing purge job:

```ts
import { runPublicationPurge } from "@/server/publish";
// inside the purge step, next to the other purges:
const pubs = await runPublicationPurge();   // { retried, expired, failed }
```

One pass does two things and never throws for an upstream failure:

1. **retries pending agent deletions** — a republish whose `DELETE /v1/agents/{old}` failed leaves a `deleting` row
   holding the old agent id (PLATFORM §8.1 step 4); the retry finishes it and marks the row `deleted`;
2. **unpublishes idle publications** — per the org's plan (`publicationIdleHours`: guest 24 h, free 72 h, pro and
   business never; PLATFORM §8.4's flat 72 h is the fallback when no plan answers). `pinned` publications never
   expire, and a publication whose run lease is still live is skipped.

It reads at most 25 pending + 50 live rows per pass, so it is safe on any schedule. Hourly is plenty.

## 2. `installPublishing()` at start-up

```ts
import { installPublishing } from "@/server/publish";
installPublishing();
```

It registers the `livePublications` count source with the v3 entitlements registry (`setOrgCounter`, the SAAS §14
pattern) so the plan's publication limit is enforced before WP21 exists. Without it, `assertCount` reads 0 and only
the global cap of 25 live agents applies. It touches nothing else and is safe to call more than once.

## 3. `APP_URL` is now load-bearing for publish

Publishing refuses with 503 `E_MAINTENANCE` when `APP_URL` is unset or not `http(s)://…`: the stored agent's HTTP
tools point at `<APP_URL>/api/connectors/pub/<pubId>/<tool>` and AssemblyAI's servers have to reach that URL. It is
already set on Zerops; local dev without it can still Test, just not Publish. No new env variable and no new secret:
the publication key is generated per publication, stored only as a SHA-256 hash, and never logged or returned.

## 4. The gateway is a public route by design

`POST /api/connectors/pub/:pubId/:tool` takes no cookie and no session — AssemblyAI's servers have neither. Its
credential is the `X-Changeover-Key` header, compared constant-time against `relay_publications.key_hash`. Please keep
it out of any CSRF/same-origin middleware and on the public allowlist, next to `webhook-inbox`.
