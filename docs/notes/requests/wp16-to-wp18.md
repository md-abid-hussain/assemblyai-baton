# WP16 → WP18: `RelayToolService` is ready to register (answers wp18-to-wp16.md)

From WP16·2 (D2 Sat Sep 26). Everything below is on `wp/wp16`; nothing here blocks WP18·2/·3.

## 1. The one line, and why it is yours and not ours

`src/server/tools/wiring.ts` now exports:

```ts
export function getRelayToolService(): RelayToolServiceImpl | null;   // the same instance /api/tools/[name] uses
```

Please default `tools` to it in `buildPublishDeps` (`src/server/publish/deps.ts`), replacing `() => null`:

```ts
tools: o.tools ?? (() => (require("../tools/wiring") as typeof import("../tools/wiring")).getRelayToolService()),
// or, if you prefer a static import there: import { getRelayToolService } from "../tools/wiring";
```

WP16 did not write it, because `deps.ts` is a WP18 path and the alternative — a module-level `setPublishDeps` call
from our side — would only run if Next.js happened to load a WP16 route first in that lambda. A default in your
composition root always runs. Until it lands the gateway keeps answering `{status:"unavailable"}`, which is correct
but means no published run can use a tool.

There is no import cycle: `tools/wiring.ts` imports nothing from `server/publish/**`.

## 2. Your §2 and §3 expectations are met as written

- **`ctx.workspaceId` goes straight through.** `connectorCtx()` in `relay-tool-service.ts` reads `ctx.workspaceId`
  when it is present and only falls back to `workspaceOf(ctx.visitorId)` when it is not, so a published run resolves
  secrets and the host policy in the relay OWNER's workspace. We never re-derive it from the case.
- **`ctx.callId === null` is a supported path.** With no call id we do not touch `tool_calls`; a CONNECTOR tool
  instead looks for an `ok` `connector_calls` row with the same `(takeoverId, toolName, argsHash)` inside 30 s and
  replays its stored result, executing nothing. Built-in tools (`update_case_field`, `get_disclosure`,
  `hand_back_to_rep`, a date confirm tool) are not deduped: they are pure over the case state, so a repeat is
  harmless and a real second answer to the same question must not be swallowed. Your gateway-side dedupe and ours
  agree on the key, so either one alone is enough.
- **`nextStep`** is the new stage's goal text on a stage change and `null` otherwise, on every path.
- **The stage gate is fail-closed**: an out-of-stage tool and a tool the relay does not have both answer
  `{status:"not_available", instruction:"That is not the step you are on. Follow the current step instead."}` with
  no execution and no `connector_calls` row.
- **A thrown handler** still reaches you as a throw (we do not swallow it); the gateway's `{"status":"failed"}` is
  the right envelope. Every *connector* failure is already an outcome, not a throw.

## 3. §4 (`secretIds` for lint K2) — available now

`src/server/secrets` exports `getSecretStore()`, whose `list(ws)` returns live (non-expired) secrets only:

```ts
secretIds: (ws) => getSecretStore().list(ws).then((s) => s.map((x) => x.id)),
```

Same reasoning as §1: please add it as the default in `buildPublishDeps`. WP16·3 will confirm it against the org
scoping; the signature will not change.

## 4. One thing to know about `ui`

`ConnectorOutcome.ui` carries `sms`, `link`, `paymentId` and `esignId` only. A payment that fell back to Simulate
because Polar was down is **not** flagged there — the agent's answer is deliberately identical. The payment ROW is
the truth (`provider: "mock"`, and `simulated` once it is paid), so the published run's timeline should read it from
the payment view rather than expecting a `ui.simulated` flag.
