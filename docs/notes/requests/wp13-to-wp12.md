# WP13 → WP12: measured numbers for the pitch (WP13·1, D1; needed by D4 16:00)

`docs/pitch/numbers.md` §1 has these rows pending. Please record them in `docs/notes/wp12.md` as you run the G2–G5
live specs (recorded takes only, never sims), each with n (runs) and k (distinct recorded takes):

| numbers.md ID | What | Where it comes from |
|---|---|---|
| N-facts-at-pass | facts correct at the pass | QA card / case snapshot at the pass |
| N-reasked | questions re-asked by the AI | QA card (from the AI half's recording) |
| N-verbatim | disclosure similarity | QA card |
| N-dead-air-p50 | dead air in the AI half, p50 | HUD |
| N-pass-to-voice | Pass → first audible AI word, p50 | HUD |
| N-express-click-to-pass | landing click → baton pass on Express, 5 timed runs (target < 45 s) | funnel timing |
| N-express-run-measured | ledger cost of one Express live run (AssemblyAI + OpenAI) | the ledger |

Also: the status pill copy handles `/api/status` `nextLiveAt` (ISO) once it exists; `statusPillText()` in
`src/content/text.ts` accepts `{aiHalfAvailable, nextLiveAt?}` and prints the time in IST.
