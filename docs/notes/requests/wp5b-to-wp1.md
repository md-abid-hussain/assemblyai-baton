# WP5b → WP1 (compiler: tool schemas, prompt, greeting)

From the Day-1 tests (`docs/notes/wp5b.md` §1):

1. **`PAY_TOOL_MODE=push` is the chosen mode (T-D1-1).** A `reply.create` while a `hold` tool is in flight produces
   no audio at all (reproduced twice), so the hold protocol's status line and reassurances would be silent. Please
   make the pay-stage output depend on the mode (`PAY_TOOL_MODE`, default `push`):
   - `send_esign_and_pay_link`: `execution_mode:"interactive"`, `timeout_seconds:10`, description ending
     "…Returns right after the text is sent; the system tells you when the payment finishes." (drop "Returns when
     payment finishes, fails or times out.").
   - `pay` stage instruction: "The customer agreed to the e-signature and text. Call send_esign_and_pay_link now with
     their words. When it returns, tell the customer in one short sentence that you texted the secure link and will
     wait while they sign and pay. Then stay quiet unless asked; the system gives status updates."
   - `hold` mode stays available behind the flag with today's texts.
2. **`VA_KEYTERMS=1` is safe** (T-D1-0 runs 3–4 and T-D1-4): keyterms are accepted in the first update and mid-session.
3. **Input mode is mutable mid-session** (T-D1-4). A partial `input` update merges (format and keyterms preserved).
   `inputModeFor` can switch per next step; the fixed-mode fallback is not needed.
4. **Greeting length.** The 65–69-word greetings of s01/s02 are 22–24 s of audio. Consider a lower cap (e.g. 45 words:
   drop the date clause first, then the vehicle clause, then the premium clause).
5. **s02 greeting and the premium clause.** §5.6's s02 example has no premium clause, but the rule says the clause
   appears when `premium_new_monthly_usd` is VERIFIED from the rep (s02: $171). The T-D1-0 fixture follows the rule.
6. **Prompt compliance seen in T-D1-4:** after the last MISSING field was filled in the `confirm` stage (with a stub
   result that did not move the stage), the agent re-asked the VERIFIED `effective_date`. With the real route the
   stage moves to `disclose`; a QA check on that path is worth adding.
7. Re-run of T-D1-0 on your compiler output at G1:
   `RUN_LIVE=1 npx tsx --conditions=react-server scripts/day1/va-t0-first-update.ts --fixture-dir <dir>` where `<dir>`
   holds `first-update-confirm.json` and `first-update-disclose.json` (`{"type":"session.update","session":{…}}`)
   for the s02 and s01 fixture snapshots.

---

## Resolution (WP14a·2, D1 Fri Sep 25; WP14a owns WP1's compiler since G1): **closed**

1. **Done.** `PAY_LINK_PUSH_TOOL`: `interactive`, `timeout_seconds: 10`, description ending "…Returns right after the
   text is sent; the system tells you when the payment finishes." `PAY_PUSH_INSTRUCTIONS` = the requested wording.
   `hold` mode keeps today's texts behind the flag. (`PROMPT_VERSION` changes accordingly.)
2. Noted (`VA_KEYTERMS=1` is the env default).
3. Noted (per-step `inputModeFor` stays; no fixed-mode fallback).
4. **Done: ≤ 40 words** (PLATFORM v2.1 lint G2). A 13-word opening ("Hi Priya, I'm Daniel's AI assistant, not a person.
   This call is recorded."), the inherited facts ("I'll finish adding Maya to the 2021 Honda Civic, starting Friday,
   October 2nd, at $142 a month."), "Ask for Daniel anytime.", then one next step ("Just to confirm, …?" /
   "I just need …." / "Ready for the updated premium?"). Over 40 words the date clause goes first, then the vehicle,
   then the premium. s01 = 39 words, s02 = 40. Three phrases were shortened to fit (incidents confirm, license-type
   and operator asks).
5. The rule stands: the premium clause appears when the premium is VERIFIED from the rep (s02: "at $171 a month").
6. Not in this unit: a QA check on the confirm-stage re-ask path is a T3 candidate (WP14a·3 owns `src/core/qa`).
7. The live re-run of T-D1-0 on the new compiler output is for WP12 at G2 (the committed fixtures are
   `tests/unit/core/compiler/__fixtures__/first-update-{confirm,disclose}.{s01,s02}.json`).
