# Baton role-play scenarios (add a driver)

22 scripted-but-loose role-play calls for **US personal-auto policy servicing, intent `add_driver`**.
Each file is two things at once:

1. **The brief for recording day.** Printable role cards are generated from these files
   (`tools/recording-kit`, command `cards`, output in `docs/role-cards.html`).
2. **Eval ground truth.** Every fact the call must establish, its final value, who says it, and its
   designed status (VERIFIED / PENDING / MISSING) at the moment the rep says the hand-off line.

Everything here is fictional: people, agencies, carriers, policy numbers, addresses, prices.

- `s01.json` to `s22.json`: one scenario per file (the file name must equal `id`).
- `shared.json`: constants shared by every scenario (required fields, status rules, the default
  hand-off line, the Twilio recording notice, and a SAMPLE change-summary template for the admin tail).
- Validator: `tools/recording-kit/src/scenarios.ts` (`.\kit scenarios` from `tools/recording-kit`).
  It enforces every rule below, so a file that passes is internally consistent.

## The set at a glance

| ID | What makes it interesting | Hand-off |
|---|---|---|
| s01 | **Golden demo call** (Priya adds Maya, 2021 Civic, $142/mo, Friday Oct 2). All facts VERIFIED | accepts |
| s02 | Start date "tomorrow" blurted right before the hand-off (PENDING) | accepts |
| s03 | Customer **declines** the AI; the rep finishes the admin tail (full human baseline) | declines |
| s04 | Date of birth corrected mid-call; premium goes **down** | accepts |
| s05 | License state never asked (MISSING; it's Wisconsin, not the policy's Illinois) | accepts |
| s06 | **Crosstalk**; a discount blurted over the hand-off line (PENDING); coverage upsell accepted | accepts |
| s07 | Distant-student discount; garaging ZIP corrected; effective date in December | accepts |
| s08 | 78-year-old parent; start date never asked (MISSING); discount pending proof | accepts |
| s09 | Learner's permit, no price change; **background noise** (TV, kids) | accepts |
| s10 | "Occasional" corrected to primary after advice; customer asks "will I have to repeat?" | accepts after question |
| s11 | Out-of-state license; **interruptions**; car choice said after the quote (PENDING) | accepts |
| s12 | **Early hand-off**: premium never quoted (MISSING). The AI must not invent a price | accepts |
| s13 | At-fault accident, underwriting review, price is an estimate; rep misspells the name | accepts |
| s14 | Customer **declines**; mother chimes in as a third voice; out-of-state license | declines |
| s15 | Stepdad doesn't know the exact birthday (MISSING, customer unsure) | accepts |
| s16 | Roommate; start date corrected to today; "is it a robot?" | accepts after question |
| s17 | Speeding ticket; **kitchen noise**; customer **declines** | declines |
| s18 | Car moves to campus; campus ZIP unknown (MISSING); quote based on the wrong ZIP | accepts |
| s19 | **Hinglish** customer, English-only rep | accepts |
| s20 | **Hinglish on both sides** (bilingual rep); "permit" corrected to full license | accepts |
| s21 | Street noise + crosstalk + a vehicle correction + PENDING date: hardest robustness case | accepts |
| s22 | Nanny who doesn't live there; **two** facts never asked (license state, start date) | accepts |

Coverage: 2 Hinglish; 7 corrections (s04, s07, s10, s13, s16, s20, s21); 6 with MISSING facts
(s05, s08, s12, s15, s18, s22); 4 with PENDING facts (s02, s06, s11, s21); crosstalk or
interruptions in s06, s11, s14, s21; background noise in s09, s17, s21; 3 declined hand-offs (s03,
s14, s17) that give full human calls for measuring the admin tail's share of the call.

## Schema (v1)

All fields are required unless marked optional.

### Top level

| Field | Type | Meaning |
|---|---|---|
| `schema_version` | `1` | Bump if the shape changes. |
| `id` | `"s01"`...`"s22"` | Must equal the file name. |
| `title` | string | One line, human readable. |
| `intent` | `"add_driver"` | The product intent this call exercises. |
| `language` | `"en"` \| `"hinglish"` | Exactly 2 scenarios are `hinglish`. |
| `language_notes` | string | Required for `hinglish`: how to code-switch (names, numbers, dates stay in English). |
| `difficulty` | `"easy"` \| `"medium"` \| `"hard"` | For stratifying eval results. |
| `tags` | string[] | Controlled vocabulary (below). Several tags are **derived and enforced**. |
| `call_date` | `YYYY-MM-DD` | The fictional date of the call. Resolves "today", "tomorrow", ages. All scenarios use `2026-09-25` (a Friday), whatever day you actually record. |
| `target_duration_s` | `{min, max}` | Target call length, within 60 to 150 s. |
| `casting` | `{rep, customer, hindi_needed}` | `rep`/`customer`: `any` \| `woman` \| `man` (a hint for who should play it). |
| `rep` | object | `name`, `agency`, `agency_city`, `agency_state` (US code), `style`. |
| `customer` | object | See below. |
| `facts` | object | Map of fact field to `Fact` (below). Ground truth. |
| `advice` | `AdviceItem[]` | The licensed-rep part (at least 1). |
| `talk_track` | `Beat[]` | Loose beats for both roles, in order (at least 6). |
| `handoff` | object | Where and how the hand-off happens. |
| `conditions` | object | `crosstalk?`, `interruptions?`, `background_noise?`: free-text descriptions; `{}` when none. |
| `directions` | `{rep: string[], customer: string[]}` | Performance notes; each list only appears on that role's card. |
| `eval` | `{traps: string[]}` | What the AI half must get right on this call (at least 1). |

### `customer`

| Field | Type | Meaning |
|---|---|---|
| `name` | string | Named insured; must also appear in `existing_drivers` as `named_insured`. |
| `persona` | string | Who they are and why they're calling (shown on the customer card). |
| `policy_number` | string | e.g. `NBM-4418207`. |
| `policy_number_say_it` | string, optional | How to say it. |
| `carrier` | string | Fictional carrier. |
| `address` | `{street, city, state, zip}` | Policy address (5-digit ZIP string). |
| `existing_drivers` | `{name, relation}[]` | `relation` is `named_insured` or a relation value. |
| `vehicles` | `{id, year, make, model, primary_driver}[]` | `id` is `veh1`, `veh2`, ... |
| `current_premium_monthly_usd` | number | Before the change. |

### `Fact`

| Field | Type | Meaning |
|---|---|---|
| `value` | string \| number \| boolean | **Final** ground-truth value (after any correction), normalized per field kind. |
| `say_it` | string, optional | How the actor should say it naturally. |
| `stated_by` | `"customer"` \| `"rep"` | Who first states it. |
| `status_at_handoff` | `"VERIFIED"` \| `"PENDING"` \| `"MISSING"` | Designed status when the hand-off line is said (rules in `shared.json`). |
| `correction` | object, optional | `{initial_value, said_wrong_by: "customer" \| "rep", how}`: the value is first said wrong, then corrected. |
| `missing_reason` | optional | Required exactly when MISSING: `not_asked` (rep skips it), `customer_unsure` (customer doesn't know it offhand), `rep_holds_back` (a rep-stated value such as the premium is not said). |
| `note` | string, optional | Anything the eval should know. Eval-only: never printed on role cards (it may contain the answer to a MISSING fact). |

### Fact fields and value kinds

Required for every scenario: `driver_full_name`, `driver_dob`, `driver_relation`, `license_state`,
`license_status`, `vehicle_assignment`, `operator_type`, `garaging_zip`, `effective_date`,
`premium_new_monthly_usd`.

| Field | Kind |
|---|---|
| `driver_full_name` | string |
| `driver_dob` | date `YYYY-MM-DD` |
| `driver_age` | integer; must equal the age from `driver_dob` on `call_date` |
| `driver_relation` | `spouse`, `domestic_partner`, `child`, `stepchild`, `parent`, `sibling`, `other_relative`, `non_relative_resident`, `non_relative_nonresident` |
| `license_state` | 2-letter US state code |
| `license_status` | `learner_permit`, `provisional`, `full` |
| `license_number` | string (not used in v1 scenarios) |
| `incidents_3y` | string (`"none"` or a short description) |
| `vehicle_assignment` | a vehicle `id`, or `"all"` (occasional on every household car) |
| `operator_type` | `primary`, `occasional` |
| `garaging_zip` | 5-digit string (where the car is kept overnight) |
| `effective_date` | date, not before `call_date`, at most 120 days after |
| `good_student_discount`, `driver_training_discount`, `distant_student_discount`, `mature_driver_discount` | `eligible`, `not_eligible`, `pending_proof` |
| `coverage_change` | string |
| `underwriting_review` | boolean (true means the quoted premium is an estimate) |
| `premium_new_monthly_usd` | money (>= 0, at most 2 decimals) |
| `premium_change_monthly_usd` | signed money; must equal new minus current premium |
| `amount_due_today_usd` | money |

### `AdviceItem`

`{topic, rep_says, customer_decision?, sets?}`. `topic` is one of `operator_assignment`,
`good_student_discount`, `driver_training_discount`, `distant_student_discount`,
`mature_driver_discount`, `coverage_limits`, `permit_listing`, `license_transfer`,
`household_listing`, `underwriting`, `garaging`, `other`. `sets` lists the facts the decision fixes.
Advice is the licensed-rep half; the AI must never repeat it as advice.

### `Beat`

`{n, who, beat, facts?, direction?, handoff?, advice?, tail?}`

- `n` runs 1, 2, 3, ... with no gaps. `who` is `rep` or `customer`.
- `beat` is a loose instruction ("give her date of birth"), never a line to read.
- `facts` lists the facts established or first mentioned in that beat. **This is what ties the
  talk track to the statuses** (see the rules below).
- `direction` is a performance note shown only on that speaker's card.
- Exactly one beat has `handoff: true`, spoken by the rep. `advice: true` marks the licensed part.
  `tail: true` marks the admin tail done by the human rep after a declined hand-off.

### `handoff`

`{at_beat, line, customer_response, customer_says, after, approx_at_s}`

- `at_beat` equals the `n` of the hand-off beat. `line` is suggested wording (natural variations OK).
- `customer_response`: `accepts`, `accepts_after_question`, or `declines`.
- `after`: `end_call` (accepted: the recording ends a few seconds later) or `rep_finishes_tail`
  (declined: the rep does effective date, change summary, text link and confirmation by hand).

## Consistency rules the validator enforces

- A **VERIFIED** or **PENDING** fact must be established by some beat at or before the hand-off beat.
- A **PENDING** fact's last mention must be within the 2 beats before the hand-off.
- A **MISSING** fact must not be established by any beat before the hand-off, and needs a `missing_reason`.
- `driver_age` matches `driver_dob` on `call_date`; `effective_date` is on or after `call_date`;
  premium change = new - current.
- A corrected fact cannot be MISSING, and its initial value must differ from the final one.
- Declined hand-offs continue with at least 3 `tail` beats; accepted ones end within 3 beats.
- Derived tags must match the content: `correction`, `missing_fact`, `pending_fact`,
  `declined_handoff`, `accepts_after_question`, `crosstalk`, `interruptions`, `background_noise`,
  `hinglish`, `premium_decrease`, `no_premium_change`, plus `out_of_state_license` when the license
  state differs from the policy state, `garaging_differs` when the garaging ZIP differs from the
  policy ZIP, and `early_handoff` when the premium is MISSING.
- Set level: ids are `s01..s22` with no gaps, and exactly 2 scenarios are Hinglish.

Tag vocabulary: `golden`, `baseline`, `teen`, `college`, `spouse`, `partner`, `parent`, `sibling`,
`stepchild`, `other_relative`, `non_relative`, `permit`, `out_of_state_license`, `violation`,
`at_fault_accident`, `underwriting_review`, `good_student`, `driver_training`, `distant_student`,
`mature_driver`, `coverage_advice`, `correction`, `missing_fact`, `pending_fact`, `early_handoff`,
`crosstalk`, `interruptions`, `background_noise`, `background_voice`, `declined_handoff`,
`accepts_after_question`, `garaging_differs`, `premium_decrease`, `no_premium_change`,
`future_effective_date`, `relative_date`, `hinglish`, `bilingual_rep`.

## Using these as eval ground truth

A recorded take lives in `data/calls/` (git-ignored) with a sidecar JSON that points back here:

- `scenario.id` and `scenario.sha256` (the exact scenario file version used for that take).
- `channel_map`: which recording channel is the rep and which is the customer.
- `review.fact_overrides` / `review.status_overrides`: what was **actually** said when the actors
  drifted from the card (set with `.\kit mark <take> --override field=value --status field=STATUS`).

Ground truth for a take = this scenario's `facts`, with the take's overrides applied on top.
Suggested scoring per takeover point (matches `research/11-ideation-verdict.md` §2.1):

- **Fact accuracy:** extracted value vs `facts[f].value` (normalize dates, ZIPs, money).
- **Status accuracy:** extracted status vs `status_at_handoff` (only meaningful at the hand-off beat;
  for other sweep points recompute from `talk_track` beats).
- **Re-asked:** AI questions that target a VERIFIED field (must be 0).
- **Newly asked:** AI questions for MISSING fields (should equal the number of MISSING facts).
- **Pending confirmed:** AI confirmations of PENDING fields.
- **Grounding:** any premium, date or amount the AI says must equal a fact value or a tool result.
- The declined calls (s03, s14, s17) have no AI half. Use them to measure how long the human admin
  tail takes (label: directional).
