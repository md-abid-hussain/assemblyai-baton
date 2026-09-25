# WP14a → WP14b: full lint, the blank relay's opening, the canned-state binding (WP14a·3, D1)

Answers `wp14b-to-wp14a.md` §4 and §5. Available on `wp/wp14a` from `b7395fb` (merges after G2, with the rest of
WP14a·3).

## 1. The blank relay fails lint G2 (please shorten its opening)

Lint now implements every PLATFORM §3.4 rule. `blankBlueprint()` (`src/server/relays/blank.ts`) passes everything
except **G2 "opening ≤ 14 words"** for every industry, because the opening names the three-word business:

> Hi Alex, I'm Example Insurance Agency's AI assistant, not a person, and this call is recorded. (16 words)

Suggested opening (13 words for single-word names, like Baton's; C1 still matches):

```
Hi {customer.firstName}, I'm {rep.firstName}'s AI assistant, not a person. This call is recorded.
```

With that line, all 7 industries lint clean (checked with a local copy of `blank.ts`).

## 2. Lint signature: one optional options argument (additive)

`lintBlueprint(bp, opts?)` and `lintBlueprintJson(json, opts?)`. Both old signatures still work. The server should
pass the context that is not in the blueprint:

```ts
interface LintOptions {
  visibility?: "private" | "unlisted" | "gallery"; // K1: no secret refs in gallery relays
  pinnedPublication?: boolean;                      // K1: none in a version a pinned publication uses
  secretIds?: ReadonlySet<string> | readonly string[]; // K2: refs to missing/expired secrets of the owner's workspace (or org)
  flagship?: boolean;                               // X1 measures the prompt without the safety block for the flagship
  simSampleRateHz?: number;                         // W2: wideband_16k over 8 kHz sims
}
```

- Without `secretIds`, K2 only fails `null` refs on used connectors (a used `http_action`'s header values, every
  `completion_webhook.hmacSecret`). With them, a ref to a secret that is gone also fails ("missing or expired").
- Consequence of K1 + K2 together: a gallery relay cannot carry a `completion_webhook` (K1 forbids its secret,
  K2 requires it). Gallery `http_action`s use plain-string headers or the unsigned demo echo.
- `lintBlueprintJson` still does not call `migrateBlueprint`; keep calling it first.

## 3. The canned-state builder (§5)

`cannedCaseState(compiled, account, state, caseId?) → CaseState` in `src/core/relay/canned.ts` matches your
`KernelBinding.cannedSnapshot(compiled, account, state)` (the 4th parameter is optional). It throws for the legacy
engine (a `CompiledRelay` with `blueprint: null`).

- `all_verified`: every required field VERIFIED (rep_only fields from the rep).
- `one_pending` / `one_missing`: the same, but the first required non-rep-only field in next-step priority is
  PENDING / MISSING.
- `nothing`: all MISSING. Optional fields stay MISSING.
- Values come from each field's first `examples` entry that normalizes against the sample (Baton: "the Civic" →
  the vehicle id).
- `readiness` follows the relay's required fields. `intent` stays the v1 literal until the P§4.7 widening.

The Studio and lint G2 use the same builder (`cannedSnapshot(bp, state, account)` for `fields` only), so the
server's compiled view and the browser agree.
