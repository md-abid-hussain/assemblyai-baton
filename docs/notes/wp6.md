# WP6 notes: tools, rating, disclosures, payments (Polar sandbox + mock + simulate), MockPhone

Branch `wp/wp6` (worktree `.wt/wp6`). Round 0 (Sep 25, 00:20–00:50 IST, 5 commits, no notes) built the payment
state machine, the stores, the Polar and mock providers, the webhook, routes #14–#18, `callTool()`,
`awaitPaymentResolution()`, the MockPhone and the T-D1-9 driver. This file starts with WP6·1.

---

## WP6·1: finish round 1 (D1 Fri Sep 25, ≈10:15–11:10 IST)

### Done

1. **Recovered the interrupted attempt.** Its uncommitted work (the `/pay/lab` MockPhone lab, `lab-seed.ts`,
   `polar-lab-e2e.ts`, the embed fail-fast) was sound and typechecked; it is committed as `92fbfc1`. Then
   `git merge main` (clean; brings G1 `a914341` and the v2.1 docs).
2. **Bound to the real G1 stack by default** (`src/server/tools/defaults.ts`; `wiring.ts` uses it unless a test or
   the integrator injects something else with `configureWp6` / `setWp6`):
   - WP1: `wp1ToolCore` = `normalizeField`, `compatible`, `resolveRelativeDate`, `spokenDate`, `disclosureText`,
     `resolvePremium`, `resolveDueToday`, `toolsForStage`, `compilePrompt`, `nextStage`, `nextStepOf`, `inputModeFor`;
   - WP3: `getCaseRepository()` → `load`, `applyEvents`, `setCaseExtras`;
   - WP2: `requireCase(req, {takeoverId, scope})` (case JWT **and** the visitor match), `getRateLimiter()` (DB),
     `getFlagStore().get().paymentsModeOverride`.
   The pre-G1 stand-ins are gone from production paths. `jwtRequireTakeover` and `memoryRateLimiter` stay for the
   route tests only.
3. **Requests answered** (all four files addressed to WP6):

   | Request | Item | Answer |
   |---|---|---|
   | wp1-to-wp6 | all helpers | Used as specified through `wp1ToolCore`. The 30-day guardrail lives in the handler (`EFFECTIVE_DATE_TOOL_MAX_DAYS`); the server resolution of `customer_words` wins over the LLM's `date` |
   | wp3-to-wp6 §1 | `applyEvents` with a deterministic id | `tool_update` id = `${caseId}:tool:${takeoverId}:${callId}` (`toolEventId`); `turnEndMs = cases.t_arm_ms + (now − armed_at)` |
   | wp3-to-wp6 §2 | `setCaseExtras`, never write `cases.state` | After every tool call (and when #15 builds the close payload) the flow parts (stage, disclosures given, payment, confirmation number) are mirrored with `setCaseExtras`, only when they differ from the row. Best effort (logged): the handlers read WP6's own tables |
   | wp3-to-wp6 §3 | `paymentViewOf(row)` | Exported from `src/server/payments/service.ts` (pure: no Polar call, no stage payload). Route #4 can use `paymentViewOf(toPaymentRecord(row))`; request filed to WP14b, the new owner of `src/server/cases/**` |
   | wp5b-to-wp6 §1 | push mode | `send_esign_and_pay_link` → `result: {status:"link_sent"}` + `ui.{sms, link, paymentId}`; `PAY_TOOL_MODE` default `push` (G1) |
   | wp5b-to-wp6 §2 | close-stage payload | **Picked the server option:** `PaymentView.stagePayload = {stage:"close", systemPrompt, tools, transcriptionMode:"min_latency"}` once `succeeded` (`PaymentViewExt`, `contracts/ext/wp6-payments.ts`). `VaStageSource` can read it from the #15 poll |
   | wp5b-to-wp6 §3 | MockPhone → controller | `MockPhoneProps.onState(s)` fires on every phone state; wire it to `setPayingState(s)`. A `payment{status:"timeout"}` event closes the overlay |
   | wp5b-to-wp6 §4 | `VaToolCaller` | `createCallTool({token, visitorToken?})` returns `CallTool`, which has exactly that signature |
   | wp8-to-wp6 §1 | `metrics.disclosures[kind]` | `{id, kind, text, criticalTokens, monthlyUsd, dueTodayUsd, premiumSource, dueSource, at}`, written with a jsonb merge (never clobbers `hud` or `verification`) |
   | wp8-to-wp6 §2 | `status_source` on every → `succeeded` | webhook → `webhook`, server GET → `server_poll`, simulate/mock → `mock` (+ `simulated=true`) |

4. **`x-baton-visitor` in the browser clients.** `createCallTool`, `createPaymentsClient` and `MockPhone`
   (`visitorToken` prop) send the signed visitor token (POST /api/cases `visitorToken`) when the page has one, for
   cookie-less browsers. WP2's `requireCase` checks that header before the `bvid` cookie.
5. **The lab runs the real handlers.** `scripts/polar/lab-seed.ts` now creates the case with WP3's `create` (kit s01
   policy), adds a takeover, and drives the real tool handlers: 8 × `update_case_field`, `confirm_effective_date`,
   both disclosures, then `send_esign_and_pay_link`. It prints a `/pay/lab` URL with the case and visitor tokens in the
   fragment. `/pay/lab` is dev only (404 in production unless `PAY_LAB=1`).
6. **Bug fixed: the embed fallback crashed React.** When Polar refused the frame, the load guard removed every node
   appended to `<body>` in that window, including React's and Next's own. The result was
   `removeChild … not a child`, and in dev a full reload. The guard now removes only the SDK's own nodes
   (`isPolarSdkNode`: the polar.sh iframe and the `.polar-loader-spinner` loader) and clears `polar-no-scroll`.

### Decisions

- **Server-side stage payload for close** (wp5b §2): the #15 poll already runs every 1.5 s, so the paid → close
  transition needs no extra round trip, and WP1 stays on the server.
- **`setCaseExtras` is a mirror, not the source of truth.** WP6's rows decide (`takeovers.stage/metrics`, the
  `payments` rows). A failed mirror write is logged and never fails the tool call, because a VA tool answer must not
  wait on a retry.
- **No stage gate in the legacy handlers.** An out-of-stage call gets the handler's own refusal
  (`not_ready`, `premium_change_first`, `disclosure_required`, `payment_not_confirmed`), not `not_available`. WP16's
  `RelayToolService` adds the generic gate (its acceptance 8).
- **`DISCLOSURE_TAX_SUFFIX`** stays off. T-D1-9 shows Polar's `total_amount` equals the disclosed amount (tax 0,
  tax-inclusive ad-hoc price). It is read from `process.env` directly (request `wp6-to-integrator.md` §1).

### Handler contract (WP16 replays this as the tool-parity test)

The executable form is `tests/unit/server/tools/g1-stack.test.ts` (real WP1, WP3 and WP2 on Postgres) plus
`tests/unit/server/tools/tools.test.ts` (fakes, edge cases). An authorized route #14 call answers **HTTP 200** with a
`ToolResponse`, refusals included (auth → 401/403, rate → 429, a handler crash → 5xx; the browser retries 409/429/5xx
once with the same `callId`). Invalid model args → `INVALID_ARGS_RESULTS[name]` (G0). `(takeoverId, callId)` is idempotent: a replay
returns the stored `result` plus the current stage payload.

| Tool | Refusals (`result`) | Success (`result`) | Side effects | Also returned |
|---|---|---|---|---|
| `update_case_field {field, value, reason}` | `{result:"rejected", reason:"unparseable", field}`; a VERIFIED field with an incompatible value → first `{result:"conflict", field, recorded_value, instruction}` + `ui.conflict` (counted in `metrics.toolFlow.fieldAttempts`), accepted only on a later call with `reason:"customer_corrected"` | `{result:"accepted", field, status:"VERIFIED", value:<display>}` (a compatible value for a VERIFIED field adds no event) | `tool_update` fact event (id per call); stage may advance confirm → disclose | `transcriptionMode` of the next step; `stage/systemPrompt/tools` when the stage changed |
| `confirm_effective_date {date, customer_words}` | `{accepted:false, reason:"unparseable" \| "out_of_range", allowed:"today to <Month Dth>"}` (range: callDate … callDate + 30 days) | `{accepted:true, effective_date, spoken, next:"disclose" \| null}` | `tool_update` for `effective_date` (server resolution of `customer_words` wins) | as above |
| `get_disclosure {kind}` | `{ok:false, reason:"not_ready", missing:[…]}` unless ready and in disclose/pay; `esign_consent` before `premium_change` → `{ok:false, reason:"premium_change_first", instruction}` | `{ok:true, disclosure_id, text, instruction:"Read this exactly, then wait for the answer."}`; idempotent per kind (the same text) | `takeovers.metrics.disclosures[kind]`; `esign_consent` → stage pay | `transcriptionMode:"min_latency"` |
| `send_esign_and_pay_link {customer_agreed_to_text, paper_copy_requested, customer_words}` | `{status:"not_sent", reason:"consent_required"}`; `{status:"not_sent", reason:"disclosure_required", instruction}` | push: `{status:"link_sent"}` at once | one payment per takeover for `premium_change.dueTodayUsd` (re-created only after failed/expired); `metrics.toolFlow.payLink` | `ui.sms` ("Harborview: Review & sign your change to policy NBM-…: <link>"), `ui.link` (`<origin>/pay/<id>`), `ui.paymentId`. The final outcome comes from #15 `toolResult` |
| `send_confirmation {}` | `{ok:false, reason:"payment_not_confirmed"}` unless the latest payment is `succeeded` with `status_source` ∈ webhook / server_poll / mock | `{ok:true, confirmation_number:"END-#####", spoken:"E N D # # # # #", sms_sent:true}` (stable per takeover) | case → `completed` | `ui.sms` "Payment received. Confirmation END-…" |
| `hand_back_to_rep {reason, summary}` | never refuses (G0) | `{status:"transferring", message:"Tell the customer <rep> is coming back on the line now."}` | case → `handed_back`; `metrics.toolFlow.handBack` | |

Stages move forward only (WP1 `nextStage`): confirm → disclose (ready) → pay (`esign_consent` read) → close (payment
`succeeded`). #15 `toolResult` once terminal: `{status:"paid", amount:"$44.52", receipt:"PAY-XXXXXX",
verified_by:"polar_webhook" | "polar_poll" | "simulated"}` or `{status:"failed" | "expired", instruction}`. The client
builds only `timeout`.

### Polar inputs (for WP16's `payment_link` adapter)

`buildCheckoutCreate` (`src/server/polar/client.ts`), called by `PolarProvider` (`src/server/payments/providers.ts`):

| Checkout field | Source |
|---|---|
| `products: [POLAR_PRODUCT_ID]` + `prices[product] = [{amountType:"fixed", priceAmount: amountCents, priceCurrency:"usd", taxBehavior:"inclusive"}]` | env; `amountCents` = `usdToCents(disclosures.premium_change.dueTodayUsd)` (the disclosed amount) |
| `customerId` | `POLAR_DEMO_CUSTOMERS[scenarioId]` (JSON map written by `scripts/polar/setup.ts --write-env`; fictional `baton-demo+<id>@mailinator.com` customers, so the email is locked) |
| `customerName` (only when there is no `customerId`) | `PolicyRecord.policyholder.firstName + " " + lastName` |
| `customerBillingAddress {country:"US", line1, city, state:"US-<ST>", postalCode}` | `PolicyRecord.address.{street, city, state, zip}` |
| `allowDiscountCodes: false` | constant |
| `embedOrigin` | the request `Origin` if it is in `EMBED_ORIGINS` or is `APP_URL`'s origin, else `APP_URL`'s origin, else none (`validatedEmbedOrigin`) |
| `successUrl` | `${embedOrigin}/pay/done?checkout_id={CHECKOUT_ID}` (the hosted new-tab variant) |
| `metadata {paymentId, caseId, takeoverId}` | our ids (the webhook maps back by `checkoutId`) |

After create: `total_amount ≠ amountCents` → `failed(amount_mismatch)`. Polar errors → one retry, then the mock
fallback labelled "Simulated payment (Polar unavailable)". Status comes only from the webhook (`checkout.updated`,
`order.paid`, `checkout.expired`) or a server GET (at most every 8 s while open; `?reconcile=1` forces one).

### Tests

- `npm run typecheck` clean; `npm test` **798/798** (67 files; the WP6 DB suites ran on the local Postgres).
- New: `tests/unit/server/tools/g1-stack.test.ts` (2 tests, real Postgres). WP2 visitor mismatch → 403. The s01 flow
  from an empty WP3 case through route #14 with the real WP1 core: 8 field updates → an out-of-range date refused →
  date accepted → disclose → pay link refused before the disclosures → both disclosures (`$142` in the text,
  `metrics.disclosures` = the returned text) → consent required → `link_sent` → confirmation refused → #17 Simulate →
  #15 `succeeded` + close payload → `END-#####`. Then `cases.state` holds stage `close`, both disclosures, the payment
  and the confirmation number; the case is `completed`; the events have deterministic ids; `status_source=mock`.
- New: `paymentViewOf` (2 tests).
- **Live lab (Polar SANDBOX, test card, $0), production build** (`next build --webpack`, then
  `PAY_LAB=1 PAYMENTS_MODE=polar … next start -p 3107`), 3 of 3 runs `ok`. Each run: seed → `/pay/lab` → lock screen →
  thread → e-sign (summary prefilled: Maya Raman, child (daughter), 2021 Honda Civic, Friday October 2nd, $142.00,
  due today $44.52) → pay sheet "$44.52" → "Pay with Polar sandbox" → the embed is refused on `localhost:3107` (not
  in Polar's Embedding list) and falls back in **5.4 s** (5.36–5.61) with the "could not open here" copy, the hosted
  link and no leftover overlay → hosted checkout paid with 4242 → `/pay/done` "Payment received" → the phone reaches
  `paid` from the server ("Verified with Polar"). Pay click → `/pay/done` median **7.5 s**; `/pay/done` → phone paid
  median **1.6 s** (0.5–2.2 s); pay click → phone paid median **9.0 s**. No page errors. The state log is clean
  (`idle → sms-received → esign → signed → checkout-loading → signed → paid`).
- The same on `next dev --webpack`: hosted (ok) and Simulate on a Polar payment (ok; `simulating` → `paid` 3.9 s, of
  which 3.4 s was the dev server compiling the route on first use).
- **T-D1-9 (round 0 driver, `scripts/day1/polar-t-d1-9.ts`, hosted variant, 5 of 5 ok):** create checkout median
  978 ms; from the tap: checkout loaded 2.8 s, filled 4.6 s, Pay clicked 5.6 s, redirected to `/pay/done` 11.6 s,
  server `succeeded` 12.4 s (max 13.2 s). In every run `total_amount == amount` (tax 0), the email is locked, the name
  and address are prefilled, there is no discount field and no editable amount, and `/pay/done` carries the checkout
  id. **Numbers for WP13:** ≈ 7 s from "Pay" to a server-verified payment; ≈ 9 s from "Pay" to the phone's ✓.

### Acceptance (v1.1 WP6)

| # | Status |
|---|---|
| 1 Webhook verification (both schemes, tampered → 403, replayed id → 202 no-op) | **PASS** (`webhook.test.ts`, `routes.test.ts` #18) |
| 2 Fail-closed (confirmation before success, client success never flips, amount mismatch, simulate from every non-terminal state in polar mode) | **PASS** (`service.test.ts`, `tools.test.ts`, `client-tools.test.ts`, `g1-stack.test.ts`) |
| 3 T-D1-9 in full | **PARTIAL.** Hosted funnel 5 × PASS; the MockPhone funnel 3 × PASS on a production build; the embed fallback PASS. **Blocked:** the embed variant, and with it "embed success does not navigate" live, needs the origin in Polar's Embedding allowlist (a user GUI action). The code path (`preventDefault` on `success`, server reconcile) is unit-tested |
| 4 Handlers (`get_disclosure` before ready, conflict flow, date range and words, consent) | **PASS** (fakes + the real WP1 core) |
| 5 Full flow with `PAYMENTS_MODE=mock`; late webhook after `timeout` → `succeeded` | **PASS** |

### Live spend

AssemblyAI **$0**, OpenAI **$0** (no LLM calls: the handlers are deterministic). Polar **sandbox only**: 6 checkouts
this unit (5 paid with the public test card 4242, 1 simulated). No real money.

### What the integrator must do (G2)

1. Merge `wp/wp6`. Nothing to wire any more: the routes (`src/app/api/{tools,payments,webhooks/polar}`, `/pay/*`)
   use the G1 stack by default.
2. **User (GUI, §11 D2):** in the Polar sandbox org, add `https://app-2b25-3000.prg1.zerops.app` (and
   `http://localhost:3107` for the lab) to Settings → Embedding. Until then the phone falls back to the hosted link
   (works, 9 s). Register the webhook `https://app-2b25-3000.prg1.zerops.app/api/webhooks/polar` and set
   `POLAR_WEBHOOK_SECRET`. Set `PAYMENTS_MODE=polar`, `POLAR_ACCESS_TOKEN`, `POLAR_PRODUCT_ID`,
   `POLAR_DEMO_CUSTOMERS` (the values `scripts/polar/setup.ts --write-env` wrote to the local `.env`), `APP_URL`
   and `EMBED_ORIGINS`. Without them the app runs in mock mode (Simulate), which is the G2 criterion anyway.
3. WP7 mounts the MockPhone (`wp6-to-wp7.md`). WP5/WP5b wire `createCallTool`, `awaitPaymentResolution` and the
   `stagePayload` (the table above).
4. `next dev` in a worktree needs `--webpack`: Turbopack refuses the `node_modules` junction ("points out of the
   filesystem root"). `next build --webpack` works.

### Where the next unit starts

WP6 round 1 is complete. **At G2 every WP6 path moves to WP16** (TASKS-v2 §4.1). WP16·2 starts from the
"Handler contract" and "Polar inputs" sections above and from `g1-stack.test.ts` (replay it against
`RelayToolService` with Baton). Open items to carry:
- the live embed run (after the allowlist; re-run `scripts/day1/polar-t-d1-9.ts` without `--hosted`, then
  `polar-lab-e2e.ts`, which then takes the embed path);
- the webhook path live on Zerops (only the poll path ran locally: no public URL for a webhook);
- `DISCLOSURE_TAX_SUFFIX` into `env.ts` (`wp6-to-integrator.md` §1).
