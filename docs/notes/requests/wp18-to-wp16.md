# WP18 → WP16: the published gateway needs `RelayToolService`, and it hands you the org

From WP18·1 (D1 Fri Sep 25, ≈21:00 IST). Nothing here blocks WP16·2/·3; it is what the gateway expects of them.

## 1. Register your `RelayToolService` (one line)

`POST /api/connectors/pub/:pubId/:tool` dispatches every published tool call through the WP16 service. It is injected,
so the gateway does not import your module:

```ts
import { setPublishDeps } from "@/server/publish";
setPublishDeps({ tools: () => getRelayToolService() });      // or, in the composition root, pass it in the overrides
```

Until it is registered the gateway answers `{"status":"unavailable"}` with HTTP 200 (a spoken apology, never a 500),
and a log line says the service is not wired.

## 2. The context is a `PublishedToolContext` (`src/core/contracts/ext/wp18-publish.ts`)

It is your frozen `RelayToolContext` plus **the publication's org**:

```ts
{ caseId, takeoverId, callId: null, visitorId, origin,
  mode: "published", publicationId, workspaceId, orgId }      // workspaceId === orgId === the RELAY OWNER's workspace
```

- **`ctx.callId` is null on this path.** AssemblyAI sends no call id, session id or signature header — WP18·0's P-2
  probe recorded every header, and there is none. Your idempotency on `(takeoverId, call_id)` therefore cannot apply
  here. **The gateway already dedupes** on `(takeoverId, tool, argsHash)` within 30 s and replays the stored body
  (`connector_calls.args_hash` + `.result`), so a retried `payment_link` never creates a second checkout. Your service
  sees one call.
- **`ctx.workspaceId` must go straight into `ConnectorCtx.workspaceId`** when `mode === "published"` (PLATFORM §6.2
  "whose secrets", SAAS §10.1 rule 5): secrets and the host policy resolve in the relay owner's org, **never the
  visitor's**. The gateway resolves it from the relay row; please do not re-derive it from the case.
- `ctx.origin` is `APP_URL` (or the request origin), for payment links.

## 3. What the gateway does with your `RelayToolOutcome`

- The response body is `{ ...outcome.result }`, plus **`next_step` at the top level** when `outcome.nextStep` is set.
  That is the whole stage-change mechanism on published runs (WP18·0 P-3: the next reply follows it, 3/3). Please keep
  returning `nextStep` = the new stage's goal text on a stage change, null otherwise.
- `outcome.stage` and `outcome.ui` are stored on the `connector_calls` row and become the published run's timeline and
  MockPhone events on the one state route. `ui.sms` / `ui.link` / `ui.paymentId` / `ui.esignId` all come through.
- The **stage gate is yours and must stay fail-closed**: all of a published agent's HTTP tools exist from the first
  second of the session (HTTP tools cannot be added mid-session, T-D1-5), so an out-of-stage call reaches you and must
  come back as `{status:"not_available", instruction:"…"}` rather than executing.
- A thrown handler becomes `{"status":"failed"}` (logged, HTTP 200). A run is capped at 40 gateway calls.

## 4. Optional: secret ids for lint K2 at publish time

Publish runs the full `lintBlueprint` with `visibility`, `pinnedPublication` and `flagship`. If you register

```ts
setPublishDeps({ secretIds: (ws) => getSecretStore().list(ws).then((s) => s.map((x) => x.id)) });
```

then K2 also fails a ref to a **missing or expired** secret before an agent is created, instead of only a null ref.
Without it, publishing a relay whose secret expired succeeds and the connector fails at call time.
