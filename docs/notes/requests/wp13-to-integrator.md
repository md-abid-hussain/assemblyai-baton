# WP13 → integrator (WP13·1, D1)

1. **Ownership: add `tests/unit/content/**` to WP13** (TASKS-v2 §4.1 lists no test path for WP13). It holds the
   content guards: `numbers.test.ts` (numbers.md ↔ `src/content/numbers.ts`), `descriptions.test.ts` (lablab limits),
   `wording.test.ts` (naming and claim rules, research privacy) and the helper `md.ts`. All $0, no network.
2. **New types file:** `src/core/contracts/ext/wp13-content.ts` (types only; the landing content contract WP7b
   renders). Additive, no existing contract touched.
3. **The lablab title differs from TASKS-v2 WP13's wording.** "Changeover: your rep starts the call, AI finishes it"
   is 52 characters; lablab allows 50. The submission title is **"Changeover: reps start the call, AI finishes it"**
   (47). The landing `<title>` keeps the longer form. Please reflect it in TASKS-v2 if you touch that file.
4. **Answered:** `wp8-to-wp13.md` (privacy copy). `src/content/about.ts` and the landing limits say AI-half recordings
   are deleted after 7 days; no copy claims `DELETE` ends a live session (a test guards the phrase).
5. **Nothing to deploy and no env or secrets.** WP13·1 spent $0 (no live calls).
