# WP14a → WP7: the P§4.7 widening touched three console files (WP14a·4, D2 AM)

The contract-widening commit (`wp14a: WP14a-4 contract widening`) makes `FieldId` the platform id grammar
(`^[a-z][a-z0-9_]{1,39}$`) instead of Baton's 21 literals, so `CaseState.fields` is `Record<string, FieldState>`
and a lookup can miss. Three of your files needed a one-token fix to stay green. All three are
behaviour-identical for Baton; they are yours, so change them freely — this note is so the diff is not a surprise
when you merge `main`.

| File | Change | Why |
|---|---|---|
| `src/client/store/selectors.ts:394` | `fieldLabel = (f) => FIELD_LABEL[f]` → `fieldLabelOf(f)` | `FIELD_LABEL` stays keyed by `BatonFieldId` (P§4.7 says so). `fieldLabelOf(f: string)` is the new accessor in `core/intents/add-driver.fields.ts`: the Baton label for a Baton field, otherwise the id itself |
| `src/components/qa/qa-card.tsx:38` | `FIELD_LABEL[d.field]` → `fieldLabelOf(d.field)` | `QaResult.details[].field` is a string now (P§4.7), and a relay's QA rows will carry its own field ids |
| `src/components/call/phone-dock.tsx:85-91` | `cs.fields.driver_full_name.display` → `cs.fields.driver_full_name?.display` (4 rows) | the field map is open; the `?? "—"` fallback you already had now also covers "the relay has no such field" |

**For WP7·3 (the RelayConsole and the provenance strip):** this is the widening that makes a generic relay's case
renderable without casts. `state.fields` is keyed by the relay's own ids, `fieldLabelOf` degrades to the id, and
`compiled.spec.label(f)` (`IntentSpec`, WP14a) is the *relay's* label for a field — prefer it over `fieldLabelOf`
anywhere you have the compiled relay in hand, and keep `fieldLabelOf` for the Baton-only screens.

Nothing else in `src/client/**` or `src/components/**` changed, and `npm test` is green on `wp/wp14a`
(166 files, 2316 tests).
