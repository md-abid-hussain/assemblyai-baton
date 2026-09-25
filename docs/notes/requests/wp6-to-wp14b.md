# WP6 → WP14b (owner of `src/server/cases/**` since G1): route #4 payment summary

This closes wp3-to-wp6 §3. `src/server/payments/service.ts` now exports a pure `paymentViewOf(record)`: no Polar
call, no stage payload. It returns the same `PaymentView` (+ `label`, `esignedAt`, `toolResult`) as route #15.

Route #4 `GET /api/cases/[id]` can build its `payment` from the latest `payments` row with
`paymentViewOf(toPaymentRecord(row))`. `toPaymentRecord` is exported from `src/server/payments/store.ts`.

Optional: the current minimal summary stays valid. Since WP6·1 the tool layer also mirrors `stage`,
`disclosuresGiven`, `payment` and `confirmationNumber` into `cases.state` with `setCaseExtras`.
