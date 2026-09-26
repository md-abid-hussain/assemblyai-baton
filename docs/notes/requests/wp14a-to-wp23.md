# WP14a → WP23: `relay-code/roundtrip.test.ts` reddens the full suite under worker contention (WP14a·4, D2 AM)

Not a correctness bug and **not caused by the P§4.7 widening** — `src/core/relay-code/**` and
`tests/unit/core/relay-code/**` are byte-identical between `main` and `wp/wp14a`
(`git diff main HEAD -- src/core/relay-code/ tests/unit/core/relay-code/` is empty). It is a **timeout**, and it is
on `main` today, so every branch will hit it intermittently. Filing it rather than fixing it because the file is
yours.

## What happens

`npm test` (166 files, 2316 tests) failed on three of five consecutive runs in this worktree, always in the same
file, always with:

```
FAIL  tests/unit/core/relay-code/roundtrip.test.ts > applyEdit → parseSource (200 random form edits)
      > keeps baton-add-driver.json exact through 200 YAML edits
Error: Test timed out in 20000ms.
```

One run failed that case plus "keeps the mini blueprint exact through 200 YAML edits and 200 JSON edits"; one run
failed it alone; two runs were fully green. Run the file on its own and it passes every time (14 tests, ~20.5 s
wall).

## Why

The three `editRun` cases are the slowest tests in the repo, and `vitest.config.ts:20` sets a global
`testTimeout: 20_000`. Unloaded, per `--reporter=verbose`:

| case | unloaded |
|---|---|
| mini blueprint, 200 YAML + 200 JSON edits | 4709 ms |
| `baton-add-driver.json`, 200 YAML edits | **6028 ms** |
| `dental-deposit.json`, 200 YAML edits | 2650 ms |

The suite spawns **166 workers, one per file** (`isolate: true`). Under that contention the 6 s case needs more
than 20 s — only ~3.3x headroom on a machine running 166 node processes, and the CI box will be tighter than this
one. Nothing is hanging: the work is real (200 × parse + edit + serialize + re-parse of a full blueprint).

## What we suggest (your call, all inside your file)

1. **Cheapest:** a per-test timeout on the three `editRun` cases — `it("…", () => {…}, 90_000)`. Leaves coverage
   and the seeds intact. Please do *not* raise the global `testTimeout` in `vitest.config.ts` — that is shared,
   and it would slow every other file's failure reporting.
2. **Better if you want the suite faster:** drop the edit count from 200 to ~60 in the two single-format cases and
   keep 200 for the mini blueprint. The mutation space is exhausted well before 200; the seeds stay deterministic
   (`rng(seed)`, mulberry32, line 33 — nicely done, it is why this was diagnosable at all).
3. Either way the fix is a one-file change and does not touch `src/core/relay-code/**`.

## For the integrator

Until this lands, **a red `roundtrip.test.ts` in a full-suite run is this flake, not a regression.** Confirm by
re-running that one file (`npx vitest run tests/unit/core/relay-code/roundtrip.test.ts`); if it passes alone, it is
this. Do not bisect on it.
