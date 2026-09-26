# WP14b → WP23: the `relay-code/roundtrip.test.ts` timeout now reddens **every** full-suite run

**From:** WP14b·4 (D2 PM) · **To:** WP23 · **Severity:** blocks a clean `npm test`, not the build

## What changed since `wp14a-to-wp23.md`

WP14a·4 reported this as an intermittent flake. It is no longer intermittent. WP14b·4 adds two Postgres test
files (`tests/unit/server/relays/saas.test.ts`, `tests/unit/server/takeovers/terminal-usage.pg.test.ts`), which
raises worker contention enough that the three `editRun` cases exceed the 20 s per-test timeout on **every** run
of the full suite on this machine:

```
FAIL tests/unit/core/relay-code/roundtrip.test.ts > keeps %s exact through 200 YAML edits
Error: Test timed out in 20000ms.
Test Files  1 failed | 173 passed (174)
Tests  2 failed | 2415 passed (2417)
```

Run alone it passes in 44 s: `npx vitest run tests/unit/core/relay-code/roundtrip.test.ts` → 14/14. **44 s alone
against a 20 s budget** is the whole story — the test was already over budget before contention, and the earlier
"flake" framing understated it.

Nothing in `src/core/relay-code/**` or `tests/unit/core/relay-code/**` changed on `wp/wp14b`:
`git diff main HEAD -- src/core/relay-code/ tests/unit/core/relay-code/` is empty.

## The ask (WP23's file; WP14b will not touch it)

The fix WP14a already proposed as cheapest, now with a stronger case for it:

```ts
it.each(galleryNames())("keeps %s exact through 200 YAML edits", (name) => {
  editRun(galleryBlueprint(name), "yaml", 200, 777);
}, 120_000);
```

120 s rather than 90 s, because 44 s is the *uncontended* time. Coverage is unchanged. If you would rather cut
the edit count, 200 → 50 also fits, but that is a real loss of property coverage and the timeout is free.

## Until it lands

A red `roundtrip.test.ts` in a full-suite run is this, not a regression. Everything else is green: **2415 passed,
2 failed, both of them these**. The integrator can confirm in one command:

```
npx vitest run tests/unit --exclude tests/unit/core/relay-code/roundtrip.test.ts   # green
npx vitest run tests/unit/core/relay-code/roundtrip.test.ts                        # green alone
```

---

## Addendum (WP14b·4, second pass — the severity is lower than stated above)

The "every full-suite run" claim above was measured on one machine under one load. After WP14b·4 parallelised
the scratch-database teardown in `tests/unit/server/relays/migration.test.ts` (a 20 s `afterAll` hook budget
was the real contention peak), **three consecutive `npm test` runs are fully green: 174 files, 2419 tests, 0
failed** — `roundtrip.test.ts` included.

So: the ask stands, but as **hardening, not a blocker**. 44 s uncontended against a 20 s per-test budget is
still only a factor of 2.3 of headroom, and the next Postgres test file any WP adds can spend it. The one-line
`120_000` is worth taking; nothing is currently red because of it.
