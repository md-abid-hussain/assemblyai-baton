# WP1 → integrator (and the planner)

## 1. Coverage tooling (package.json is not WP1's)

TASKS WP1 asks for ≥ 90% line coverage on `src/core/case` and `src/core/compiler`, but `@vitest/coverage-v8` is not
installed, so `vitest --coverage` cannot run. Please add at the next gate:

- devDependency `@vitest/coverage-v8` at `5.0.1`, the same version as `vitest`;
- the script `"test:cov": "vitest run tests/unit --coverage.enabled --coverage.provider=v8 --coverage.include=src/core/case/** --coverage.include=src/core/compiler/**"`.

Until then, WP1 measured coverage with a scratch V8 collector, described in `docs/notes/wp1.md` under "Measured numbers".
The collector did not change any repo file.

## 2. DESIGN amendments for the planner (decided in WP1; details in docs/notes/wp1.md "Decisions")

1. **§5.4.1 effective-date window: 90 days, not 60.**
   - Why: the kit's own ground truth has a VERIFIED start date 84 days out (s07: 2026-12-18 on a 2026-09-25 call).
   - The AI half keeps its 30-day guardrail in `confirm_effective_date` (§5.8).
   - The window is the `EFFECTIVE_DATE_MAX_DAYS` constant.
2. **§5.4.3 readiness.** A PENDING premium does not block `ready` either. The AI can neither ask for the premium nor set
   it, and the disclosure falls back to the rating tool.
3. **§5.9.5 dynamic cap.** "Open required fields" excludes the server-resolvable premium.
4. **§5.6 greeting.** Without a VERIFIED name, the summary reads "add a new driver on the {vehicle}" instead of
   "add a new driver as a driver on the {vehicle}".
5. **§5.4.2 pseudo-code.** Two points:
   - The "conflict only (keep cur)" branch records the conflict. The pseudo-code as written sets nothing there.
   - A `tool_update` that replaces an already-confirmed, incompatible value flags `customer_corrected_verified`.
     It also emits a conflict card for rep review.
6. **§5.13 lexicon: strong and weak patterns.** The generic words "car", "vehicle", "license" and "name" count only
   when no specific field matched. Without this, "the ZIP code where the car is kept" would also count as a re-ask
   of `vehicle_assignment`.
7. **§5.13 tag questions.** "…X. Is that right?" is merged into one sentence, so the greeting's own confirm counts
   as `pendingConfirmed`, as §5.13 step 2 intends.
8. **§5.3 step 5.2.** The token-LCS ratio is LCS/|quote|: the share of the quote's tokens found, in order.

---

## Integrator status (G1, 2026-09-25)

- §1: **not installed**. `@vitest/coverage-v8` is not in DESIGN §3.3; the planner decides whether to add it for the ≥90% gate.
- §2: forwarded to the planner (DESIGN amendments); no code change at G1.
Details: `docs/notes/g1.md` ("Integrator requests: disposition").
