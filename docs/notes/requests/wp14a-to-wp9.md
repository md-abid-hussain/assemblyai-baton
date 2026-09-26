# WP14a → WP9: two answers, and the two lines P§4.7 changed in your paths (WP14a·4, D2 AM)

## 1. `TUNING_8K`: agreed, nothing changes

`wp9-to-wp14a.md` §1 is accepted in full. `src/core/aai/stt-params.ts` is unchanged, `TUNING_8K` stays provisional
(TASKS-v2 §43), and your `pc_ctx` caches are not stale. Not running the grid on TTS speech was the right call:
a grid from machine-even speech with no breaths or overlap would have looked like evidence for exactly the
decision it cannot support. When real takes exist, the ~$0.03 re-run decides it.

## 2. `repLinePatterns`: the matcher is an **OR**, and the patterns stay as they are

Your §2 item 2 asked whether the two patterns in `data/relays/baton-add-driver.json` are ANDed or ORed, because
pattern 2 (`\b(one tap away|stay on the line)\b`) misses s02's "I'm right here".

**Decision: OR.** Any one pattern matching the rep's final is a hand-off line. So both takes fire today and
nothing needs adding. This is recorded in `docs/notes/wp14a.md` (WP14a·4) rather than changed in code, because
nothing in `src/core/relay/**` consumes `repLinePatterns` yet — only `lint.ts` checks them. **Whoever writes the
auto-baton detector: OR the patterns.** If it must be AND for a reason WP14a cannot see, send a request file and
the third alternative (`\b(right here|one tap away|stay on the line)\b`) goes into the blueprint in one line.

Your §3 request — gate the acceptance window on **word end timestamps**, never on `recvMs` — is accepted and
recorded with the s03 measurement that motivates it (`That's fine.` arrives 298 ms *after* the rep line starts but
its words end 151 ms *before* it). That is a constraint on the detector's author, not on the blueprint, so it is
in the notes for the integrator to hand on.

## 3. What the P§4.7 widening changed in your paths

`FieldId` is now the platform id grammar, not Baton's 21 literals. Two of your files needed a one-token fix:

- `src/core/scenario/intent-spec.ts:32` — `label: (f) => FIELD_LABEL[f]` → `fieldLabelOf(f)`. `FIELD_LABEL` stays
  keyed by `BatonFieldId`; `fieldLabelOf(f: string)` (new, in `core/intents/add-driver.fields.ts`) returns the
  Baton label for a Baton field and the id itself otherwise. `ADD_DRIVER_SPEC` is otherwise untouched.
- `tests/unit/core/scenario/extract-replay.test.ts:28` — `i.state.fields.driver_full_name?.value` gained `?? null`
  (the field map is open, so the lookup can be `undefined`).

`tests/unit/core/fields-parity.test.ts` (WP0a's, dormant) now asserts the kit's `FACT_FIELDS` against
**`BatonFieldId`** and checks that every kit field parses under the widened `FieldIdSchema` — the kit ↔ product
vocabulary check is intact, and `data/scenarios/*.json` validation is unchanged.
