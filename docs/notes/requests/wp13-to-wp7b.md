# WP13 → WP7b: consuming `src/content/**` on `/` (WP13·1, D1)

Import everything from `@/content` (pure data and pure helpers, no `server-only`/`client-only`: safe in server and
client components). Types live in `src/core/contracts/ext/wp13-content.ts` and are re-exported from `@/content`.

1. **`LANDING`** is the whole page in order: `hero`, `statusPill`, `pipeline` (Shadow → Pass → Prove), `directions`
   (the four-directions strip; exactly one item has `ours: true`), `numbersRow`, `gallery`, `fieldNotes`, `limits`,
   `footer`. **`ABOUT.sections`** is the folded-in `/about` copy (how a relay runs, why both APIs, Studio, trust,
   privacy); render it below the field notes or wherever it fits.
2. **Rich text:** `hero.subline`, field-note `finding`s and `ABOUT` paragraphs are `Inline[]`
   (`string | {strong} | {code}`). Render `{strong}` as `<strong>` and `{code}` as `<code>`; `plainText()` gives the
   plain string for `<meta>` and aria labels.
3. **Primary CTA:** `hero.primaryCta.target = {kind: "featured-call", express: true}` → `/call/<featured callId>?express=1`
   (the `featured` entry of `src/generated/calls.json`). Label = `label` + " · " + `details.join(" · ")`.
   `countdownSec` (3), `fullCallLabel` and `provenanceBanner` are for the countdown/banner.
4. **Pass loop:** `passLoop.videoSrc` and `posterSrc` are **null** until WP13 cuts `public/landing/pass-loop.mp4`
   (D3 22:00). Until then render a still/placeholder box using `passLoop.alt` as its text, never a broken `<video>`.
   When the MP4 lands, WP13 sets both paths; captions are in `passLoop.captions`.
5. **Status pill:** `statusPillText(LANDING.statusPill, status)` where `status = {aiHalfAvailable, nextLiveAt?}` from
   `/api/status`, or `null` when the API is down (acceptance 1: the page still renders). It formats `nextLiveAt` as
   IST "HH:MM".
6. **Numbers row:** `renderableNumbers(numbersRow.ids)` returns only measured values (all four are `null` at v1). If
   it returns nothing, render `numbersRow.fallbackTitle` with `renderableNumbers(numbersRow.fallbackIds)` instead.
   Show each number's `label`, `value`, and `provenance` (tooltip or small print). Never render a `null` value.
7. **Gallery:** the API (`GET /api/relays?scope=gallery`) is the source of cards; `gallery.cards` gives the copy per
   slug (`baton-add-driver`, `dental-deposit`, `telecom-plan-change`) and the static fallback when the API is down. If
   the API's badge differs (for example Telecom cut to "Template · not yet run"), the API wins.
8. **Secondary link:** `hero.secondaryLink.label` ("Build a relay →") normally; `fallbackLabel` ("See the blueprint
   behind Baton →") if the Baton-first fallback (P§13.4) is on.
9. **Wording:** please don't edit copy in your components; ask here (`wp7b-to-wp13.md`) and WP13 changes
   `src/content`. The tests in `tests/unit/content/**` guard the naming rules.
