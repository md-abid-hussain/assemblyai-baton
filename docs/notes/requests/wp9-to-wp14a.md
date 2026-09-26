# WP9 → WP14a: the `TUNING_8K` check, and live rep-line finals for `repLinePatterns` (WP9·2, D1)

## 1. `TUNING_8K`: no request. Keep 160/1000

WP9·2 owed you "the `TUNING_8K` check on 2 real takes". **It did not run: there are no real takes** (the user has
not recorded; `data/calls/` holds only its README). The two takes in `calls.json` today are clearly-labelled
**simulated** stand-ins (generated script + TTS voices).

I deliberately did **not** run `scripts/day1/stt-grid.ts` on them, although the budget allowed it. TTS speech has no
breaths, no overlap, no filler and machine-even pacing, so its end-of-turn behaviour says nothing about the
thresholds a real 8 kHz phone call needs; a grid result from it would look like evidence and be worse than none.

So `src/core/aai/stt-params.ts` needs **no change from WP9**, and `TUNING_8K` stays provisional per TASKS-v2 §43.
The `pc_ctx` caches committed today were made with the current params, so they are not STALE; if you do change the
thresholds later, WP9's stale detection will flag them and a re-run is ~$0.03 for both takes.

## 2. Evidence for `repLinePatterns` (`data/relays/baton-add-driver.json`)

These are the **real Streaming STT finals** (universal-3-5-pro, `pc_ctx`, 8 kHz µ-law, the production per-channel
params) for the rep's hand-off line in the two takes, as the detector will actually see them:

| take | scripted line | STT final (rep channel) | `recvMs` |
|---|---|---|---|
| s01 | `OK if my assistant finishes the paperwork? I'll be one tap away if you need me.` | `Okay, if my assistant finishes the paperwork, I'll be one tap away if you need me.` | 130400 (line ends 129640) |
| s02 | `Got it. OK if my assistant wraps up the paperwork? I'm right here.` | `Okay, if my assistant wraps up the paperwork, I'm right here.` | 89300 (line ends 88617) |

Three things to take from it:

1. **"OK" comes back as "Okay," and the question mark as a comma.** Any pattern anchored on `OK\b` or on `?` misses.
   Your current patterns are safe: `\b(finish|finishes|wrap|wraps) (up )?the paperwork\b` matches both takes.
2. **Pattern 2 (`\b(one tap away|stay on the line)\b`) matches s01 but NOT s02** — s02's scenario ends
   "I'm right here". If the matcher ANDs the patterns, auto-baton never fires on s02 and the picker take is dead
   weight; if it ORs them, both fire. Nothing in `src/core/relay/**` consumes `repLinePatterns` yet (only
   `lint.ts` checks them), so this is a decision you still own. If it is AND, please either add
   `\b(right here|one tap away|stay on the line)\b` or drop pattern 2.
3. The customer's acceptance finals land at `recvMs` 132000 (s01, `"Sure, go ahead."`) and 90900 (s02,
   `"Yeah, go ahead."`), i.e. ~0.8 s after the labelled `acceptEndMs`. Your acceptance patterns match both.

Cached turns for replaying either take: `public/data/cached-turns/<callId>.json`; labels with
`handoff.{lineStartMs,lineEndMs,acceptStartMs,acceptEndMs}` in `data/labels/<callId>.json`.

**Caveat, please keep it attached to any fixture you copy from here:** this is generated speech. It is good enough
to pin string handling (casing, punctuation, word choice) and useless for timing or turn-detection decisions.

---

## 3. The declined take, and one way to get it wrong (WP9·3, D1)

WP9·3 added `s03_sim_20260925T110000Z` — the **declined** hand-off (`handoff.declined = true`,
`acceptStartMs = null`). It is the only take that exercises the branch where the customer says no and the rep
finishes the tail himself, so it is the fixture to test auto-baton's *refusal* against.

The rep line came back the same way as s01 (`Okay, if my assistant finishes the paperwork, I'll be one tap away if
you need me.`), and both current `repLinePatterns` match it. The decline itself —
`I'd rather just finish with you, if that's all right.` — matches **neither** rep pattern and **not** the acceptance
pattern, which is the correct outcome.

**The hazard, measured.** The customer finals around the hand-off, with word timestamps and arrival time:

| `recvMs` (arrival) | word span | final |
|---|---|---|
| 111700 | 109664–111360 | `Okay.` |
| **112800** | **111392–112351** | **`That's fine.`** |
| 118700 | 116544–118304 | `Oh.` |
| 121800 | 118432–121210 | `I'd rather just finish with you, if that's all right.` |

The labelled rep line is **112502–117336**. `That's fine.` is the customer answering the *previous* question: its
words end at 112351, **151 ms before the line starts**. But the final does not *arrive* until 112800 — **298 ms
after the line starts**.

So: if the acceptance matcher opens its window on the rep line and then tests customer finals **by arrival
(`recvMs`)**, it reads `That's fine.` as consent and auto-batons a call the customer **declined**. If it tests by
**word end timestamp** (`words[last].end` ≥ `lineEndMs`, or at least ≥ `lineStartMs`), it is correct and waits for
the real reply.

**Request:** gate the acceptance window on word timestamps, not on arrival time, and treat a final whose words
predate the rep line as belonging to the previous turn. A streaming final can arrive several hundred ms after the
speech it describes — that lag is normal and is exactly the size of this trap.

Fixture to pin it: `data/cache/stt/s03_sim_20260925T110000Z/pc_ctx.jsonl` (the real finals above),
`data/labels/s03_sim_20260925T110000Z.json` (the labels), `public/data/cached-turns/s03_sim_20260925T110000Z.json`.
The same generated-speech caveat from §2 applies: use it for string and ordering logic, not for timing thresholds.
