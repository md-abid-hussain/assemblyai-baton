# WP16 → WP20: the Connectors settings page's two APIs

Both are live on `wp/wp16` (WP16·3). Shapes, verbatim, so the page can be built against them.

## 1. Secrets — `/api/secrets` (PLATFORM §6.4)

- `GET` → `200 {"secrets":[{"id":"sec_…","name":"desk_token","createdAt":"…","expiresAt":"…"}]}` (`secret:read`).
  Names and dates only: **no route, log, export or error ever returns a value.** The UI line is
  "••••  set 2 min ago", from `createdAt`.
- `POST {name, value}` → `201` with the same object, or `200` when the name already existed (the id is KEPT, so
  blueprint refs `{"$secret":"sec_…"}` stay valid). `secret:write` = admin+.
- `DELETE /api/secrets/:id` → `204`, also for an id this workspace does not have (nothing is disclosed).
- Refusals: `403 E_FORBIDDEN` (role), `402 E_PLAN_LIMIT` with `limit:{key:"secrets",used,limit,plan}` (the plan's
  count), `429 E_SECRET_LIMIT` (the store's own cap), `400 E_BAD_REQUEST` (name `[A-Za-z0-9_-]{1,40}`, value 1 KiB).
- The plan decides the count and the life: Guest 3 / 7 days, Free 5 / 30 days, Pro 50 / never, Business 200 / never.
  `expiresAt` is a real date in every plan (a "never" is a century out), so the page can render it unconditionally;
  please show the 7-day warning only when `expiresAt` is within ~30 days.

## 2. Allowed hosts — `/api/app/connector-hosts` (SAAS §5.6)

- `GET` → `200 {"hosts":["hooks.acme.com"],"limit":10,"enabled":true,"plan":"pro"}` (`secret:read`).
  `enabled:false` (limit 0) on Guest and Free: show the upgrade card, not an empty list.
- `POST {host}` → `201 {"hosts":[…],"limit":10,"enabled":true}` (`secret:write`, account required).
  A scheme and a path are stripped for you, so pasting `https://hooks.acme.com/relay` works.
- `DELETE ?host=hooks.acme.com` → `200 {"hosts":[…],"limit":10}`.
- Refusals worth their own copy in the UI:
  - `402 E_PLAN_LIMIT` — either "custom connector hosts are a Pro feature" (limit 0) or the count is used up;
  - `400 E_VALIDATION` — a wildcard, an IP literal, a port, our own origin, or **a host that does not resolve to a
    public address** (we check DNS at add time, so the owner finds out here rather than mid-call);
  - `403 E_FORBIDDEN` — a member (hosts are admin+, like secrets).
- Both mutations write `connector.host_added` / `connector.host_removed` to the audit log.

## 3. The connector test console — `POST /api/connectors/test` (PLATFORM §6.5)

`{relayId, connectorId, args}` → a report with `status`, `result` (exactly what the agent would see), `request`
(the line and headers, secret values as `‹secret:name›`), `signature`, `httpStatus`, `ms`, `reqBytes`, `resBytes`,
`raw` + `rawTruncated` (the raw body, capped at 2 KiB on the deployed build) and `droppedHeaders`. `connector:test`
= member+, 20 per day per visitor (`429`).

`dryRun:true` with `wouldDo:{…}` comes back for `payment_link`, `confirmation`, `esign_mock`, `sms_mock` and
`completion_webhook`: those need a run, so the console renders what would happen and creates nothing. Please label
that state in the UI ("Dry run — nothing was sent") rather than showing it as a failure; `status` is `"refused"`
for it, which is not an error either.
