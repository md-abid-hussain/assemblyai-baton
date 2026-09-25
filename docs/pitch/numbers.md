# Changeover: numbers sheet (v1)

**Version:** v1, 2026-09-25 (D1, WP13·1). **Next:** v2 at D4 16:00 with the measured headline metrics (WP13·4).

Every number that appears in the deck, the video, the README, the lablab copy or the landing page must have a row
here. If a number is not in this sheet, it does not go out.

## 0. How to read this sheet

**Tags:**

| Tag | Meaning | What the row must carry |
|---|---|---|
| `measured` | We measured it ourselves | How many runs, sessions or takes; where it was measured; the public file with the log |
| `sourced` | A public source says it | The source's name and URL. We cite the source, not our reading of it |
| `assumption` | Our estimate or a pricing hypothesis | The basis, and the formula when it is derived from other rows |

A number derived from other rows takes the weakest tag of its inputs, and its row shows the formula.

**Rules:**

1. **Headline metrics come from recorded takes only.** They are always stated as **"n runs over k distinct recorded
   takes"**, never "n calls" when n replays of one take. Simulated calls never feed a headline metric.
2. **A pending number is never shown.** `pending` rows render nowhere (the app skips them; the deck and the video
   leave the slot out).
3. **Freed rep time is locked** until s01 is confirmed to carry the handoff line "OK if my assistant finishes the
   paperwork? I'll be one tap away if you need me." If s01 says "I'll stay on the line", freed rep time is a roadmap
   rung only ("one rep supervises N relays"), and no row in §4 about rep minutes may be used.
4. **API measurements** state the client's location (India, about 170 ms round trip to the US endpoints) and the
   number of sessions. They describe the API, not Changeover's end-to-end performance.
5. Sourced numbers from secondary pages say so. Re-check every URL before the final deck (D5).
6. The rows mirrored in `src/content/numbers.ts` (the app's copy) must match this sheet: same ID, tag and value. A unit
   test (`tests/unit/content/numbers.test.ts`) enforces it.

**Status of the s01 handoff line (rule 3):** unconfirmed at v1. The recording session runs D1 10:00–14:30 IST; WP9
labels the takes. Until someone records the answer here, N-tail-cost stays locked.

---

## 1. Headline product metrics (measured on recorded takes; all pending at v1)

Sources when measured: the G2–G5 live specs on Zerops (WP12) and the video takes, read from the QA cards and the HUD.

| ID | Number | Tag | Provenance | Source | Used in |
|---|---|---|---|---|---|
| N-facts-at-pass | pending | measured | Facts correct at the pass; n runs over k distinct recorded takes | QA cards, WP12 live specs | landing numbers row, slide 5, video 1:40 |
| N-reasked | pending | measured | Questions re-asked by the AI, counted from the AI half's recording; n runs over k distinct recorded takes | QA cards | landing, slide 5, video 1:40 |
| N-verbatim | pending | measured | Disclosure similarity, async transcript vs the disclosure text; n runs over k distinct recorded takes | QA cards | landing, slide 5, video 1:40 |
| N-dead-air-p50 | pending | measured | Dead air in the AI half, p50; n runs over k distinct recorded takes | HUD timings | landing, slide 5 |
| N-pass-to-voice | pending | measured | Pass the baton → first audible AI word, p50 (includes the rep's handoff line, which masks it) | HUD timings | slide 6, video 0:35–1:40 |
| N-express-click-to-pass | pending | measured | Landing click → baton pass on the Express path, 5 timed runs | WP7b / WP12 funnel timing | README "judge path" |
| N-express-run-measured | pending | measured | Ledger cost of one Express live run (AssemblyAI + OpenAI) | the ledger, WP12 | README cost table, slide 8 |
| N-tail-share | pending | measured | Share of a recorded call after the pass (administrative tail), labelled "directional" | recorded takes | slide 7 (market), only as "directional" |

The disclosure threshold (similarity ≥ 0.90 plus the critical words) is a design parameter, not a result. It may be
stated as "we check against a 0.90 threshold", never as a measured score.

---

## 2. Measured on AssemblyAI's APIs while building (client in India)

All logs are public in this repo. IDs match the tests in the logs.

| ID | Number | Tag | Provenance | Source | Used in |
|---|---|---|---|---|---|
| N-smoke-tests | 61 | measured | Live API smoke tests before product code: 45 pass, 10 partial, 5 fail, 1 skipped; Voice Agent, Realtime STT, async and OpenAI (2026-09-24) | `research/10-smoke-test-results.md` §0 | landing fallback row, README |
| N-va-ready | 611–672 ms | measured | First `session.update` → `session.ready`, 5 Voice Agent sessions (2026-09-24) | `docs/notes/wp5b.md` §4 | landing fallback row, field notes |
| N-va-first-audio | 292–341 ms | measured | `session.ready` → first audible greeting chunk, 2 sessions (leading silence 180–240 ms) | `docs/notes/wp5b.md` §4 | slide 6 |
| N-greeting-v1 | 65–69 words | measured | Our first greeting: 22.0–23.7 s of audio before the customer could answer, 4 sessions (T-D1-0). Why the greeting is now ≤ 40 words | `docs/notes/wp5b.md` §1 | field notes iteration log, video 2:50 |
| N-stage-change | 650–880 ms | measured | `session.update{prompt, tools}` then `tool.result` → the new stage's tool call, 2 runs (T-D1-2) | `docs/notes/wp5b.md` §1 | landing fallback row, field notes |
| N-early-tool-result | about 1.0 s faster | measured | Sending `tool.result` before `reply.done` (VA-8). The absolute times were `reply.create`-triggered turns without endpointing, so only the difference is quoted | `research/10-smoke-test-results.md` §1.1 | field notes |
| N-hold-silent | 0 audio chunks | measured | `reply.create` during a tool `hold`: 2 of 2 runs silent (T-D1-1) | `docs/notes/wp5b.md` §1 | field notes, video 2:50 |
| N-va-turn | 2.1–2.6 s | measured | End of speech → audible reply, plain turns, `min_latency` (balanced 2.9–3.2 s; tool turns ≈ 3.5–5 s) | `research/10a-voice-agent-smoke.md` test 4 | slide 6 (as a range, with the client location) |
| N-per-channel | 27/27 finals | measured | One Universal-3.5 Pro Realtime session per channel on one two-speaker stereo test clip: 27/27 finals on the right speaker, 21/21 entities, 4.3% WER (ST-6) | `research/10-smoke-test-results.md` §1.2 | landing fallback row, field notes, slide 6 |
| N-diarization-mixed | 7 of 8 finals | measured | Same clip, one diarized session: 7 of 8 finals mixed both speakers; finals cut on a ~10 s grid (ST-5) | `research/10-smoke-test-results.md` §1.2 | field notes |
| N-idle-not-billed | 12 s | measured | Idle Voice Agent socket before the first update: not closed, 2.26 s billed for a 14.7 s socket (T-D1-3 part A) | `docs/notes/wp5b.md` §1 | field notes |
| N-async-verify | 3.4–4.2 s | measured | AI-half recording → async multichannel transcript; artifacts ≈ 7 s after the session ends; pre-signed URLs last 1 h (VA-13) | `research/10-smoke-test-results.md` §1.1 | field notes, slide 6 |
| N-turn-8k | 160 ms | measured | `min_turn_silence` for 8 kHz audio (with `max_turn_silence` 1000 ms), chosen on a proxy grid (TTS dialog → 8 kHz µ-law): 19/19 entities, 0 merged turns, p50 final ≈ 0.73 s. Provisional until the real-take grid | `docs/notes/wp4.md` T-D1-6 | field notes, limits |
| N-delete-ended | 404 at once | measured | `DELETE /v1/sessions/{id}` on an ended session: GET and the recording URLs 404 at once. On a live session: 204, but the session keeps running (T-D1-0b, 2 sessions, 2026-09-25) | `docs/notes/wp8.md` | field notes, privacy copy |
| N-dob-zip | 4/4 | measured | Date of birth and ZIP captured correctly by the Voice Agent in both turn modes, clean TTS audio (T-D1-4) | `docs/notes/wp5b.md` §1 | backup only |

---

## 3. Costs and pricing

List prices are AssemblyAI's published prices as read on 2026-09-24. Re-check at D5.

| ID | Number | Tag | Provenance | Source | Used in |
|---|---|---|---|---|---|
| N-price-va | $4.50/h ($0.075/min) | sourced | AssemblyAI Voice Agent API list price (STT, LLM and voice in one price) | https://www.assemblyai.com/pricing | slide 8 backup, README cost table |
| N-price-rt | $0.45/h | sourced | Universal-3.5 Pro Realtime list price, per channel | https://www.assemblyai.com/pricing | README cost table |
| N-price-async | $0.21/h | sourced | Universal-3.5 Pro async list price, per channel | https://www.assemblyai.com/pricing | README cost table |
| N-cogs-ai-min | ≈ $0.09 per AI-finished minute | assumption | = N-price-va $0.075 + async on 2 channels $0.007 + LLM ≈ $0.005 (estimate) | this sheet | slide 8 backup |
| N-shadow-cogs | ≈ $0.017 per shadowed minute | assumption | = 2 channels × $0.45/h ($0.015/min) + extraction ≈ $0.002 (estimate) | this sheet | slide 8 backup |
| N-headline-price | $0.30 per AI-finished minute | assumption | Pricing hypothesis, not validated with a buyer. "The relay studio is included." | PLATFORM §11 | slide 8, video 3:20–4:10 |
| N-gross-margin | ≈ 70% | assumption | = ($0.30 − $0.087) / $0.30 = 71%, stated as "about 70%" | this sheet | slide 8 backup |
| N-backup-fees | $99 / $49 / $0.03 | assumption | Backup slide only: $99 per published relay per month; $49 per rep seat per month; shadowed minutes at $0.03 (COGS N-shadow-cogs) | PLATFORM §11 | backup slide |
| N-express-run | ≈ $0.18 AssemblyAI + ≈ $0.005 OpenAI | assumption | One Express live run from list prices × typical durations (full call ≈ $0.27). Replaced by N-express-run-measured at D4 | PLATFORM §10.1 | README (until measured) |
| N-live-runs-day | ≈ 8 live runs a day | assumption | ≈ $1.43/day AssemblyAI judging cap ÷ N-express-run. Why live runs come in four windows a day | PLATFORM §10.3 | README limits |

---

## 4. Market, buyer and the problem

| ID | Number | Tag | Provenance | Source | Used in |
|---|---|---|---|---|---|
| N-repeat-55 | 55% | sourced | "55% of end users say having to repeat themselves is what they hate most", AssemblyAI 2026 Voice Agent Insights Report. Quote the report's own wording; re-read it before the final deck | https://www.assemblyai.com/voice-agent-report | slide 2, video 0:12–0:35 |
| N-agencies | ≈ 37,000 agencies, 9.9 staff on average | sourced | US independent P&C agencies, Big "I" / Future One 2026 Agency Universe Study (reported by IA Magazine). Staff = all roles, not CSRs only | https://www.iamagazine.com/news/big-i-and-future-one-release-2026-agency-universe-study/ | slide 7 |
| N-csr-wage | $21.53/h | sourced | BLS OEWS median hourly wage, customer service representatives (SOC 43-4051), May 2025; $22.47/h at insurance carriers. Read via secondary pages that cite the series (callforce.global, rezoom.io); confirm on bls.gov before the deck | https://www.bls.gov/oes/current/oes434051.htm | slide 8 backup |
| N-csr-loaded | $28–38/h (≈ $0.47–0.63/min) | sourced | Fully loaded CSR cost, the range where three independent build-ups converge: RDI Corporation (2.25× base wage, itemised), Office Beacon (base wage = 60–65% of cost), Call Force ($25–45/h) | https://rdicorp.com/what-is-the-real-cost-of-operating-a-contact-center-9-factors-to-calculate-true-hourly-agent-cost/ ; https://www.officebeacon.com/blog/call-center-outsourcing-vs-in-house-team-cost-guide-2026 ; https://callforce.global/blog/call-center-outsourcing-cost/ | slide 8 (only with N-tail-cost) |
| N-aht | 4–10 min | sourced | Insurance service-call handle time as commonly reported (claims and complex calls run longer). A range, never one number | https://www.givainc.com/blog/call-center-kpi-benchmarks-by-industry/ ; https://agenttech.io/glossary/average-handle-time | slide 2 |
| N-ai-trust | 20% → 39%; 16% | sourced | Consumer support for AI in P&C insurance, year over year (Insurity survey, April 2026); only 16% are comfortable with AI renewing a policy. Secondary page; find the Insurity release before using | https://actuary.info/insights/carrier-ai-goes-customer-facing-in-risk-management-platforms | slide 2 (optional: why a human starts the call) |
| N-tail-min | ≈ 3 min | assumption | The administrative tail of an add-a-driver call (confirmations, disclosure, payment, confirmation number). Replace with N-tail-share when measured | this sheet | slide 7 |
| N-tail-cost | ≈ $0.90 vs ≈ $1.41–1.89 | assumption | **LOCKED (rule 3).** A 3-minute tail finished by AI at N-headline-price vs the same 3 minutes of loaded rep time (N-csr-loaded). Only usable once s01's handoff line is confirmed | this sheet | slide 8 (only if unlocked) |
| N-calls-agency | ≈ 500 calls a month | assumption | Inbound calls per agency per month. Anchor: one vendor case study of a 7-producer agency with "roughly 1,000 inbound calls a month", mostly servicing. We halve it for the average agency | https://www.sonant.ai/blog/producers-order-takers-reclaim-hours | slide 7 |
| N-change-share | 25% | assumption | Share of those calls that are policy changes (endorsements). No public number found; stated as an assumption | this sheet | slide 7 |
| N-market | ≈ $50M a year | assumption | Bottom-up, US independent agencies only: N-agencies 37,000 × N-calls-agency 500 × 12 × N-change-share 25% × N-tail-min 3 min × N-headline-price $0.30 = $49.95M. Excludes carriers' own service centers, MGAs, and the other templates (healthcare front desks, telecom, utilities) | this sheet | slide 7, video 3:20–4:10 |

**Market slide wording:** "≈ $50M a year in AI-finished minutes from US independent agencies' policy-change calls
alone (bottom-up; every input labelled)". Show the formula on the slide.

**Numbers we do not use** (found, but their named sources could not be located or were aggregator chains): the
"28% of CSR capacity on policy changes", "6.8% endorsement error rate" and "4–6 hours a week of supervision" figures,
and the "77% / 91% / 42% AI adoption" round numbers. Do not put them anywhere.

---

## 5. The market scan behind "not found in our market scan"

| ID | Number | Tag | Provenance | Source | Used in |
|---|---|---|---|---|---|
| N-scan | 22 | sourced | Vendors we checked for the handoff direction, September 2026: 19 voice-agent and contact-center vendors plus 3 PCI payment-handoff vendors (below); 13 from their own docs or pages, 9 through secondary pages only. A desk scan, not an exhaustive search | this section | landing directions strip, slide 3, video 3:20 |

What we found, by direction (the wording on every public surface is "not found in our market scan", never "first",
"only" or "no one"):

| Vendors | Handoff direction documented | Checked via |
|---|---|---|
| Genesys Cloud, NICE CXone, Twilio Flex, Google CCAI (Dialogflow CX) | AI → human (NICE also AI → AI) | vendor docs |
| Five9, Talkdesk, Amazon Connect | AI → human | secondary pages only |
| Cresta, ASAPP, Observe.AI, Balto | none: the human keeps the call and the AI assists them | secondary pages only |
| Parloa, Sierra, Decagon, Retell AI, Bland AI | AI → human (Sierra also: the AI asks a human for a decision and keeps the call) | vendor pages and blogs (Decagon: its own glossary) |
| PolyAI, Synthflow | AI → human | secondary pages only |
| Vapi | human cues the AI (Live Call Control, "whisper"), AI → AI (squads, handoff tool), AI → human (warm transfer) | vendor docs |
| PCI Pal, Sycurio, Eckoh | none: the same human stays on the line while card entry is masked | vendor pages (PCI Pal: marketing only) |

Public sources:
- Vapi: https://docs.vapi.ai/calls/call-features , https://docs.vapi.ai/squads/handoff , https://docs.vapi.ai/squads/silent-transfers , https://docs.vapi.ai/calls/assistant-based-warm-transfer
- Decagon: https://decagon.ai/glossary/what-is-ai-agent-handoff
- Bland AI: https://bland.ai/blogs/warm-transfers
- Retell AI: https://retellai.com/blog/effortless-handoffs-with-retell-ais-warm-transfer-feature
- Parloa: https://parloa.com/knowledge-hub/warm-transfer-vs-cold-transfer/
- Sierra: https://sierra.ai/product/meet-your-agent
- Genesys: https://help.genesys.cloud/articles/about-genesys-virtual-agent/
- NICE CXone: https://help.nicecxone.com/content/aiassistantsandbots/virtualagenthub/virtualagenthub.htm
- Twilio Flex: https://twilio.com/docs/flex/admin-guide/integrations/google-dialogflow-cx-native-integration
- Sycurio: https://sycurio.com/blog/ivr-payment
- Eckoh: https://eckoh.com/blog/agent-assisted-versus-self-service-ivr-payments-whats-the-difference

Open before the final deck: a direct docs check of Five9, Talkdesk, Amazon Connect, PolyAI and Synthflow, which were
read only through secondary pages.

---

## Change log

- **v1 (D1, WP13·1):** first sheet. Headline metrics pending; API measurements from `research/10*` and the Day-1
  notes; list prices; the bottom-up market; the scan list. Loaded CSR cost sourced as $28–38/h (≈ $0.47–0.63/min),
  lower than the $0.60–1.00/min range PLATFORM §11 guessed, so N-tail-cost uses the sourced range.
