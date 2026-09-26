# WP18 → WP14b: mount `POST /api/relays/:id/publish`, bind `PublicationLookup`

From WP18·1 (D1 Fri Sep 25, ≈21:00 IST). Answers your `wp14b-to-wp18.md` items 1, 2 and 8.

`src/server/publish/**` is on `wp/wp18` and merges with `main`. Two things live in **your** paths, so they are
requests rather than edits:

## 1. One route file (3 lines), `src/app/api/relays/[id]/publish/route.ts`

`src/app/api/relays/**` is WP14b's (TASKS-v2 §4.1), and `V2_ROUTES.relayPublish` fixes the path, so the handler is
mine and the file is yours:

```ts
import { publishRelay } from "@/server/publish/routes";

/** POST /api/relays/:id/publish → PublishResponse (WP18; PLATFORM §8.1). */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = publishRelay;
```

`publishRelay` already resolves its own principal (`requirePrincipal(req, { perm: "relay:publish" })`), enforces the
quotas and maps its own errors, so nothing else is needed. The other four WP18 routes are mounted under paths I own
(`src/app/api/publications/**`, `src/app/api/connectors/pub/**`).

If you would rather not carry the file, the integrator can add it at the merge; it is the only unmounted route.

## 2. Bind the publication lookup (your item 1 / item 8)

```ts
import { publicationLookup } from "@/server/publish";
// in buildRelaysDeps: publications: o.publications ?? publicationLookup()
```

`publicationLookup()` is a thin `{ forRelay(relayId): Promise<PublicationView | null> }` over the live row; it does a
single indexed join and does **not** compile the relay, so `RelayDetail` stays cheap. Until you bind it,
`RelayDetail.publication` stays `null` and everything else works.

## 3. What WP18 already does for you (your item 2)

- `relays.status` goes to `'published'` on publish and back to `'draft'` on unpublish **and** on an idle purge
  (gallery relays are left alone). Your LRU archive therefore keeps skipping published relays.
- Publish snapshots the draft through `registry.snapshotVersion`, so it is content-addressed exactly as your
  `/versions` route is: publishing an unchanged draft reuses the version and creates no new one.
- Publish calls `registry.moderate(versionId)` and treats `ModerationUnavailableError` as 503 (fail-closed, your
  item 6).

## 4. `DELETE /api/relays/:id` (your item 3)

Please **do** call `Publisher.unpublish` before the soft delete once §2 is bound — otherwise deleting a published
relay leaves a live stored agent on the AssemblyAI account with no row pointing at it from the UI (the purge job
still reaps it by idle time, up to 72 h later, and the F6 audit still recognizes it meanwhile, so this is tidiness
rather than a leak):

```ts
const pub = await d.publications?.forRelay(row.id);
if (pub) await new PgPublisher(getPublishDeps()).unpublish(pub.id, ws);
```
