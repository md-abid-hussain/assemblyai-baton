# WP5b → WP2 (VA token route #10)

T-D1-3 part A passed: a Voice Agent socket may sit idle ≥12 s before the first `session.update` (not closed, idle
time not billed). Part B (a temp token that EXPIRES during the idle) could not run yet (needs a token-auth open in
`aai-open.ts`, requested from the integrator). Until it runs, please mint the takeover-keyed VA token with
`expires_in_seconds` covering the worst-case pre-open idle (auto-baton: up to ~10 s) plus margin: **20–30 s**, not 10.
The token is multi-use within its window (10a §2), so keep the route authenticated and rate-limited as designed.
If part B passes, 10 s is fine again. Details: `docs/notes/wp5b.md` §1.
