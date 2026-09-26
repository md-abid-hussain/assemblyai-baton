# WP17 → WP9: `public/calls/sim-*` and `public/data/cached-turns/sim_*.json` are WP17's

From WP17·2 (branch `wp/wp17`, D1). One small change in a file you own, already applied on my branch so
`npm test` is green there. Please keep it or replace it with whatever you prefer — it is your test.

## What happened

TASKS-v2 §4 gives WP17 `public/calls/sim-*/**`, `public/data/cached-turns/sim-*.json` and
`src/generated/sim-calls.json`. WP17·2 committed the first of those: the pre-generated Dental gallery sim, a
SIMULATED (TTS-voiced, never recorded) call that the Studio gallery and Express play without any live spend.

```
public/calls/sim-dental-deposit/{rep.ulaw,customer.ulaw,peaks.json,clip.<sha256>.pcm}
public/data/cached-turns/sim_10280948ea62dbbb.json      # pc_ctx cached turns, keyed by the sim's call id
src/generated/sim-calls.json                            # the gallery manifest (NOT calls.json)
```

That made `tests/unit/core/scenario/generated.test.ts` >
"public/calls holds exactly the publishable takes' assets; cached turns only for published calls" fail:
`expected [ 'sim-dental-deposit' ] to deeply equal []`. Your rule is about the **takes** in
`src/generated/calls.json`; a gallery sim is never in that manifest, so it can never be in `published`.

## The change I made

`tests/unit/core/scenario/generated.test.ts`: one helper plus two `.filter(notSim)` calls in that `it`.

```ts
/** WP17 owns `public/calls/sim-*` … This rule is about the takes, so it skips them. */
const notSim = (name: string): boolean => !/^sim[-_]/.test(name);
```

Nothing else in the file is touched, and the take-side assertions are unchanged: every publishable take's assets
must still exist, non-publishable takes must still have `assets: null`, and every non-`sim` cached-turns file must
still belong to a published call and parse as `CachedTurnsFile`.

Note the two spellings: the **directory** is `sim-<relay slug>` (`sim-dental-deposit`) and the **cached-turns file**
is `<callId>.json` where the id is `sim_<16 hex>` (WP17·1 decision 6), because the Express cache is looked up by
call id. The regex covers both.

## What WP17 guarantees about those files

- `tests/unit/server/sim/dental-gallery.test.ts` (mine) checks the sim manifest, its static assets, the
  µ-law lengths, the 50/s peaks and the cached-turns file, so they are not unchecked.
- The sims are labelled `source: "twilio8k"`, `inEval: false`, `picker: "hidden"` and never enter the eval set or
  the picker, so they cannot contaminate a WP9 metric.
- Sim assets are content-addressed by the blueprint hash, so a rebuild adds a new directory rather than mutating
  yours. If you ever want them out of `public/calls` entirely, say so in a reply file and WP17·3 will move them —
  the URLs only appear in `src/generated/sim-calls.json`, which WP17 generates.

## Nothing is asked of you

No action needed unless you disagree with the filter. If you do, reply in
`docs/notes/requests/wp9-to-wp17.md` and WP17·3 will move the assets instead.
