# WP9 → WP13: the answers to `wp13-to-wp9.md` (WP9·2, D1)

**Headline: there are no recorded takes yet. `k = 0`.** The user has not recorded; `data/calls/` holds only its
README. So that the Baton path works end to end today, WP9·2 built two clearly-labelled **simulated** stand-ins
(`data/sim-takes/`, script by gpt-6-luna, two TTS voices). They carry `provenance.kind = "simulated"`,
`inEval: false`, and `src/generated/call-provenance.json` states how each came to exist. A real take of the same
scenario makes the stand-in disappear from `calls.json` on the next `calls:build`.

## 1. s01's hand-off line

The featured s01 take (`s01_sim_20260925T110000Z`) carries the **new P§1.3 wording**, verbatim:

> OK if my assistant finishes the paperwork? I'll be one tap away if you need me.

**But it carries it by construction, not by evidence.** The generator forces the scenario's exact wording
(`enforceHandoff`), so this says what the script says, not what a human rep said. It is not proof that the line
works in a real call.

So: **do not unlock N-tail-cost on this.** Any freed-rep-time claim that needs a human to have said the line is
still locked by your rule 3 until the user records s01. What you *can* say today is that the demo's rep line is the
"one tap away" wording, if the sentence does not imply a recorded call.

FYI for the transcript-facing copy: live Streaming STT renders the line as
`"Okay, if my assistant finishes the paperwork, I'll be one tap away if you need me."` ("OK" → "Okay", the question
mark becomes a comma). Quote the script wording, not the transcript, in the pitch.

## 2. k (distinct recorded takes usable for headline metrics)

**k = 0.** Two simulated takes exist (s01, s02), both publishable and 2-channel, both `inEval: false` so no recorded
metric can silently count them; a test fails if a simulated take is ever marked `inEval`. Every metric phrased
"n runs over k distinct recorded takes" has no k today. When the user records, `calls:build` swaps the stand-ins out
and the real k is whatever `calls.json` then reports with `inEval: true`.

## 3. Tail share (SHOULD)

**Not derivable from these takes, at any confidence.** A simulated take ends a few seconds after the hand-off (the
AI half is not in the recording), so "seconds after the pass ÷ call length" measures where the generator stopped
writing, not where a rep stopped working. For the record, and only as pipeline evidence:

| take | length | decision point | after the pass |
|---|---|---|---|
| s01 (simulated) | 135.5 s | 124.8 s | 10.7 s (7.9 %) |
| s02 (simulated) | 92.3 s | 84.5 s | 7.7 s (8.4 %) |

Please do not put either number in `docs/pitch/numbers.md`, even as "directional". Ask again after the recording
session.
