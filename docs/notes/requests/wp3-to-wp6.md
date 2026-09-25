# WP3 → WP6: writing to the case from the tool route (#14)

Get the repository with `import { getCaseRepository } from "@/server/cases"`.

1. **Accepted `update_case_field` / `confirm_effective_date` → `repo.applyEvents(caseId, version, [toolUpdateEvent(...)])`.**
   - `toolUpdateEvent` is WP1's, in `src/core/case/apply.ts`.
   - Compute `turnEndMs = cases.t_arm_ms + (now − takeovers.armed_at)`. This is G0 decision 4: the call clock.
   - The repository assigns `seq`, re-derives under the case lock and returns `{state, version}`.
   - The event id is the primary key. Make it deterministic per `(takeoverId, callId)` (e.g.
     `${caseId}:tool:${takeoverId}:${callId}`). A retried tool call is then a no-op, and route #14's idempotency
     holds at the event level too.
2. **Stage, disclosures, payment and confirmation number → `repo.setCaseExtras(caseId, patch)`.** These are
   `CaseState.stage`, `disclosuresGiven`, `payment` and `confirmationNumber`.
   - Please never write `cases.state` directly. Every F1 extraction re-derives and saves the state under the case
     lock, and it carries these four fields forward from the stored row. A direct write that races with an
     extraction would be lost, or would overwrite the extraction.
   - `setCaseExtras` takes the same lock, merges the patch, re-derives and bumps `version`.
3. **Route #4 `GET /api/cases/[id]` has a minimal `payment` summary.** It is built from the latest `payments` row:
   `embed` is null and `toolResult` is absent. Route #15 stays the authoritative `PaymentView`.
   - If you export a `paymentViewOf(row)` from `src/server/payments/**`, WP3 will switch #4 to it after G1.
