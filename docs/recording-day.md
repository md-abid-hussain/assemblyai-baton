# Recording day: 22 role-play calls for Baton

Today you'll record short, realistic phone calls where an insurance agency rep helps a customer
**add a driver** to their car insurance, then offers to hand the paperwork to "my assistant".
These calls become Baton's evaluation set: the facts on each role card are the ground truth, and
the recordings show how well the live pipeline hears and tracks them on real phone audio.

- **Who:** you plus 1-2 volunteers. Everyone needs their own phone.
- **How long:** about 3 hours for 22 calls, including setup and a few re-takes. Each volunteer
  needs roughly 45-60 minutes if you split the calls between two volunteers.
- **Cost:** about $6-7 of your ~$9 Twilio balance (details in [section 2](#2-what-it-costs)).
- **Nothing is scripted word-for-word.** Each role card gives loose beats and the facts to get
  across. Say things your own way.

Everything in the scenarios is fictional: names, agencies, policy numbers, addresses, prices.
Nobody uses their own personal details. The only real personal data is your voices and phone numbers.

---

## Contents

1. [One-time setup (the evening before, ~15 min)](#1-one-time-setup-the-evening-before-15-min)
2. [What it costs](#2-what-it-costs)
3. [Consent (before anyone is dialed)](#3-consent-before-anyone-is-dialed)
4. [Who plays what](#4-who-plays-what)
5. [Recording one scenario, step by step](#5-recording-one-scenario-step-by-step)
6. [The 22 scenarios and a suggested order](#6-the-22-scenarios-and-a-suggested-order)
7. [Role cards](#7-role-cards)
8. [Tips for natural speech](#8-tips-for-natural-speech)
9. [The two Hinglish calls](#9-the-two-hinglish-calls)
10. [Re-recording](#10-re-recording)
11. [Checking a recording](#11-checking-a-recording)
12. [What to send back](#12-what-to-send-back)
13. [Troubleshooting](#13-troubleshooting)
14. [Command cheat sheet](#14-command-cheat-sheet)
15. [Baton add-ons for today: s01 consent check and the "tail pack"](#15-baton-add-ons-for-today-s01-consent-check-and-the-tail-pack)

---

## 1. One-time setup (the evening before, ~15 min)

All commands are for **Windows PowerShell**, run from the kit folder. In Git Bash use `./kit.sh`
instead of `.\kit`.

**Step 1. Install the kit.**

```powershell
cd C:\Users\abid1\Desktop\assembly-ai\tools\recording-kit
npm install
```

**Step 2. Add everyone's phone number and consent.**

```powershell
copy participants.example.json participants.json
notepad participants.json
```

For each person, fill in:

- `phone`: full international format, `+91` then the 10-digit mobile number, no spaces, no leading 0.
- `consent.recording`: `true` only after they said yes (see [section 3](#3-consent-before-anyone-is-dialed)).
- `consent.scope`: `"public"` or `"metrics_only"` (their choice).
- `speaks_hindi`: `true` for anyone who can do the Hinglish calls.
- `defaults`: who plays the rep and the customer when you don't say otherwise.

`participants.json` is git-ignored; it never leaves your laptop.

**Step 3. Run the health check.** It's read-only: nothing is dialed or changed.

```powershell
.\kit check
```

You want every line to say `[ok]`: Twilio login works, the account is active, the balance is
shown, your +1 number is voice-capable, India calling is enabled, and all 22 scenarios are valid.

**Step 4. Print or share the role cards.** Open `docs\role-cards.html` in a browser and press
Ctrl+P. Each card prints on its own page; "Save as PDF" works if you want to send cards on WhatsApp.
See [section 7](#7-role-cards).

**Step 5. Do a dry run.** This checks everything and shows exactly what would be sent to Twilio,
without making any call:

```powershell
.\kit call --scenario s02 --rep me --customer volunteer1 --dry-run
```

**Step 6. Tell your volunteers what to expect:**

- The call comes from a **US number (+1)**, and their phone will probably show **"International
  Call"**. That's normal (Indian carriers tag every call from abroad). Suggest they save the number
  as a contact, e.g. "Baton recording", so spam filters don't block it.
- They need to be in a **different room or place** from you, with their own phone, a quiet spot
  (except the noise scenarios) and their role card on paper or a second screen.

---

## 2. What it costs

Both phones are called from your Twilio number, so you pay for **two call legs** plus the recording.
Rates are from `research/15-twilio-recording.md` (Twilio's India pricing page):

- India mobile: **$0.0496 per minute, per leg**, billed per started minute.
- Recording: **$0.0025 per minute.**
- Storage: $0.0005 per recorded minute per month while Twilio keeps the file (a few cents in total).

The first leg also includes ~20 seconds of recording notice and ringing before the conversation.

| Conversation length | Billed minutes (your leg + their leg) | Cost per call |
|---|---|---|
| 60 s | 2 + 1 | ~$0.15 |
| 90 s | 2 + 2 | ~$0.20 |
| 2 min | 3 + 2 | ~$0.25 |
| 2.5 min | 3 + 3 | ~$0.31 |
| 5 min (the hard cap) | up to 7 + 5 | ~$0.61 |

**Estimate for the day:** 19 normal calls at ~$0.20-0.25, 3 longer "declined" calls at ~$0.31,
plus ~5 re-takes: **about $6.50 total.** Your balance was $9.09 when this kit was tested. Your Twilio
number's monthly rental also comes out of the same balance.

Guard rails the kit enforces:

- Every call is capped at **5 minutes of conversation** (`timeLimit=300`), and each phone rings for
  at most 30 seconds.
- Before dialing, the kit shows your balance and refuses to call if it's below the worst case for
  one call plus $0.50 (about $1.11).
- If you expect many re-takes, top up $5-10 before you start.

---

## 3. Consent (before anyone is dialed)

Their voices may end up in the demo video, so get **written consent** (a WhatsApp reply is fine)
from every volunteer before their number goes into `participants.json` with `recording: true`.
Offer two options: public, or metrics only.

### Message template (copy, edit the bits in {braces}, send)

> Hi {name}! Thanks for helping with my hackathon project, **Baton**: an AI assistant that finishes
> the paperwork part of insurance phone calls.
>
> **What I'm asking:** tomorrow ({date}) we'd do some short role-play phone calls, 1-2 minutes each,
> about {N} calls. You'd play an insurance customer (or rep) using a role card. Everything on the
> card is made up: fictional names, addresses and numbers. Please don't share any real personal details.
>
> **How it works:** the calls come from a US number (+1 ...) and your phone may show "International
> Call". A phone service (Twilio) records the call. The audio is transcribed by AssemblyAI (a
> speech-recognition service), and the text is analysed with OpenAI's models to test and measure the
> product. Your phone number stays in a private file on my laptop.
>
> **Please choose one:**
> - **A. Public:** my voice and the transcript of these role-play calls may appear in the public
>   demo video, the demo website and the public code repository for the hackathon.
> - **B. Metrics only:** keep my voice and transcript private. Use them only to compute numbers
>   (like accuracy) that are published without my voice.
>
> You can switch from A to B, or ask me to delete your recordings, any time. Tell me before
> {Sep 29} and nothing public will include you. After something is published I'll remove your
> recording from everything I control.
>
> If you're OK with this, reply: **"I agree to be recorded: A"** or **"I agree to be recorded: B"**.
> No pressure at all if you'd rather not!

When they reply, update their entry in `participants.json`, for example:

```json
"consent": { "recording": true, "scope": "metrics_only", "date": "2026-09-25", "how": "WhatsApp reply" }
```

The kit refuses to dial anyone whose `consent.recording` is not `true`, and every recording's
sidecar file stores each person's consent scope. A take is marked **publishable** only when both
people chose "public".

**Background (not legal advice):** India is generally treated as a one-party-consent country for
call recording, so recording a call you take part in is allowed. Asking everyone anyway is the
right thing to do, matches how Baton itself treats consent, and covers the notice duties under
India's data-protection law (DPDP Act 2023) if the audio is kept or published. On the call itself:

- The person dialed first hears Twilio's notice: "This practice call is being recorded for the
  Baton hackathon project."
- The rep opens every call with "this call is recorded", in character, so the second person hears
  it too.

---

## 4. Who plays what

- **Rep** = the agency's customer-service rep. By default that's you, and you're dialed first
  (recording **channel 1**).
- **Customer** = the policyholder calling to add a driver. Usually a volunteer (recording **channel 2**).
- **Rotate for variety.** Voice variety makes the eval stronger. Let volunteers play the rep in
  some calls, e.g. `--rep volunteer1 --customer me`. With two volunteers, they can even do calls
  between themselves while you just run the kit (`--rep volunteer1 --customer volunteer2`).
- **Casting hints:** the scenario table shows whether the customer was written as a woman, a man,
  or anyone. It's a hint, not a rule. The Hinglish calls need Hindi speakers: the customer in s19,
  and both people in s20.
- **Different rooms, always.** If both phones are in the same room, each phone picks up the other
  person's voice, which ruins the channel separation.
- **Earphones help.** With wired or Bluetooth earphones you can read your card on the same phone
  or a laptop. Speakerphone only when the card says so (s17's kitchen).

---

## 5. Recording one scenario, step by step

1. **Pick the scenario** (see [section 6](#6-the-22-scenarios-and-a-suggested-order)) and give each
   person **only their own card**. The rep card doesn't show the customer's surprises, and that's
   on purpose.
2. **Both read the card for 2 minutes.** Don't memorize it. Know who you are, the facts you'll say,
   any twist ("say the wrong ZIP first"), and when the hand-off comes.
3. **Start the call** from the kit folder:

   ```powershell
   .\kit call --scenario s02 --rep me --customer volunteer1
   ```

   The kit prints the plan: who's on which channel, the caps and the cost. Check the masked numbers
   (last 4 digits), then **type `call` and press Enter.** Anything else cancels.
4. **The first phone (the rep's) rings.** Answer it and you'll hear the short recording notice.
   Then the customer's phone rings (+1, "International Call"). When they answer, the terminal shows
   **"BOTH CONNECTED - recording now"**.
5. **The rep opens:** greeting, agency name and "this call is recorded", then follow the beats.
6. **The hand-off (★ on the cards).** The rep says something like *"OK if my assistant finishes the
   paperwork? I'll stay on the line."* and then **stops talking** so the customer can answer.
   - If the customer **accepts**: rep says "Great, you'll hear them in a second" and **hangs up**
     within about 3 seconds. The recording ends there. That's intended: Baton's AI takes over
     from this point.
   - If the customer **declines** (s03, s14, s17): the rep finishes the paperwork part by hand
     (TAIL beats), then closes the call.
7. **Hang up** on either phone. The kit waits for Twilio to finish the recording (usually well
   under a minute), downloads it, splits it into a rep file and a customer file, and prints levels
   and any warnings.
8. **Listen and mark it** ([section 11](#11-checking-a-recording)):

   ```powershell
   .\kit mark s02_20260925T101503Z --keep
   ```

**Emergency stop:** press **Ctrl+C** once in the terminal and the kit asks Twilio to hang up the
call. Or just hang up the phone. From another terminal you can run `.\kit hangup <CallSid>`.

---

## 6. The 22 scenarios and a suggested order

| ID | What happens | Length | Customer | Twist to watch |
|---|---|---|---|---|
| s01 | Priya adds daughter Maya (17) to the Civic: **the demo-video call** | 75-120 s | woman | none (clean baseline) |
| s02 | Mark adds son Lucas (16) | 60-100 s | man | says "starting tomorrow" right before the hand-off |
| s03 | Janet adds daughter Hannah (19) | 100-150 s | woman | **declines the AI**; rep finishes by hand |
| s04 | Tyler adds new wife Jasmine | 60-100 s | man | gets her birthday wrong, corrects it; price goes **down** |
| s05 | Greg adds son Owen (18) | 60-100 s | man | rep never asks the license state |
| s06 | Angela adds daughter Zoe (16) | 75-120 s | woman | **talks over the rep**; blurts a discount during the hand-off |
| s07 | Laura adds college student Claire (20) | 75-120 s | woman | wrong ZIP first, then corrects it; December start |
| s08 | Denise adds her father Walter (78) | 60-110 s | woman | rep forgets to ask the start date |
| s09 | Rachel adds Ethan (15, learner's permit) | 60-100 s | woman | **TV and kids in the background**; price unchanged |
| s10 | Chris adds partner Alex | 75-120 s | anyone | "occasional" becomes "primary"; asks "will I have to repeat?" |
| s11 | Fatima adds brother Omar | 75-120 s | woman | **kids interrupt twice**; car choice said at the very end |
| s12 | Kevin adds daughter Ava (16) | 60-100 s | man | rep hands off **before saying any price** |
| s13 | Patricia adds son Dominick (22) | 75-120 s | woman | rep misspells the name; accident means the price is an estimate |
| s14 | Rosa adds her mother Carmen | 100-150 s | woman | **mom chimes in** in the background; **declines the AI** |
| s15 | Mike adds stepdaughter Sophie (17) | 60-110 s | man | doesn't know her exact birthday |
| s16 | Nathan adds roommate Jordan | 60-110 s | man | changes the start date to today; "is it a robot?" |
| s17 | Kavitha adds son Rohan (17) | 100-150 s | woman | **kitchen noise on speaker**; **declines the AI** |
| s18 | David adds daughter Leah (18) | 75-120 s | man | car moves to campus; he doesn't know that ZIP |
| s19 | Sunita adds son Arjun (17) | 75-120 s | woman, Hindi | **Hinglish** customer, English-only rep |
| s20 | Rohan adds wife Kavya | 75-120 s | man, Hindi | **Hinglish on both sides**; "permit" corrected to "full license" |
| s21 | Darnell adds nephew Marcus (20) | 75-120 s | man | **outdoors near traffic**, talks over the rep, changes the car |
| s22 | Allison adds the nanny Gabriela | 60-110 s | woman | rep skips two questions (license state, start date) |

**Suggested order:**

1. **Sound check = first real take:** s02. It's short and easy. If both channels sound fine,
   keep it; if not, fix the setup and discard it.
2. **Warm-up block** (quiet, English): s04, s05, s08, s12, s15, s16, s22.
3. **The golden call s01** once everyone is relaxed. Do it twice and keep the better take:
   it's the one the demo video is built around.
4. **Corrections and tricky facts:** s07, s10, s11, s13, s18.
5. **Crosstalk and noise:** s06, s09, s17, s21 (s21 needs the customer outdoors, near a road,
   **walking, never driving**).
6. **Long "declined" calls:** s03, s14.
7. **Hinglish:** s19, s20, whenever your Hindi-speaking volunteer is free.

`.\kit report` at any point shows which scenarios still need a take.

---

## 7. Role cards

The printable cards are generated from the scenario files, so they always match the ground truth:

- **`docs/role-cards.html`**: open in a browser, press **Ctrl+P**. Page 1 is the index, then one
  REP card and one CUSTOMER card per scenario, each on its own page. "Save as PDF" makes it easy to
  send the right pages on WhatsApp.
- **`docs/role-cards.md`**: the same content, readable in VS Code or GitHub.
- To regenerate after editing a scenario: `.\kit cards` (or `.\kit cards --only s01,s19`).

**What's on each card**

| REP card | CUSTOMER card |
|---|---|
| Who you are (name, agency, style) | Who you are and why you're calling |
| **Hand-off box:** at which beat, the line, what the customer will answer, what to do next | **Hand-off box:** what the rep will ask and exactly how you answer |
| "On your screen": the policy, drivers, cars, current premium | Your policy: number (and how to say it), address, cars |
| Rating result: the new price, and when you may say it | Facts you know: each fact, how to say it, and a "watch out" (say it wrong first, don't mention it, bring it up last) |
| The advice you must give (the licensed-rep part) | Directions (noise, interruptions, mood) |
| Rules: what to skip on purpose, what not to read back | Talk track with **your beats in bold** |
| Talk track with **your beats in bold**, ★ at the hand-off | |

**Example: s01, REP card (abridged)**

> You are **Daniel Reyes**, licensed rep at Harborview Insurance Agency (Cleveland, OH).
> English · easy · aim for 75-120 s · hand-off at beat 17 (~95 s)
>
> **Hand-off:** at beat 17 say something like "OK if my assistant finishes the paperwork? I'll stay
> on the line." She'll agree ("Sure, go ahead."). Say "Great, you'll hear them in a second" and end
> the call.
>
> **Rating result:** new premium $142/month (up $46 from $96).
>
> **Advice:** list Maya as primary on the car she'll drive most; good-student discount with a 3.0+
> GPA; suggest raising liability limits for a teen driver (about $11 more a month).
>
> **Talk track:** 1. greet + "this call is recorded" · 3. get name + policy number · 5. confirm the
> address, ask Maya's name and date of birth · 7. read them back, ask license state/type/tickets ·
> 9. ADVICE: which car, primary driver, where it's parked · 11. ADVICE: good-student, liability
> limits · 13. ask the start date · 15. read back + quote $142 · **17. ★ HAND-OFF** · 19. end the call.

**Example: s01, CUSTOMER card (abridged)**

> You are **Priya Raman**, a working parent; your daughter Maya just passed her driving test.
>
> | What | Say it like |
> |---|---|
> | Name | Maya Raman, M-A-Y-A |
> | Date of birth | March 14th, 2009 (she's 17) |
> | License | Ohio, probationary, passed last Tuesday, no tickets |
> | Car | the Civic, every day to school, parked at home, 44107 |
> | Grades | 3.6 GPA |
> | Liability upsell | "let's keep the limits as they are for now" |
> | Start | next Friday, October 2nd |
>
> **Hand-off:** when the rep asks "OK if my assistant finishes the paperwork?", answer "Sure, go ahead."

**About dates:** every scenario happens on **Friday, September 25, 2026**, whichever day you really
record. "Tomorrow" on a card means Saturday the 26th. Say dates the way the card says them.

---

## 8. Tips for natural speech

- **Glance, then talk.** Read a beat, look away, say it your way. Reading sentences aloud sounds
  robotic, and that's exactly what we're trying not to record.
- **Normal pace, normal fillers.** "Um", "let me see", "OK so" are all fine. Real calls have them.
- **Numbers and names: clear, once.** Say policy numbers, dates, ZIPs and prices clearly the first
  time. Spell names when the card says so ("Maya, M-A-Y-A").
- **Let silences happen.** Don't rush to fill a pause, and don't talk over each other unless your
  card tells you to (s06, s21).
- **Make twists sound real.** A correction should sound like a genuine slip ("August 12th... no,
  the 21st"), not an announcement.
- **Phone at a normal distance**, not pressed to your mouth (that causes clipping), and no
  speakerphone unless the card says so.
- **Quiet room** unless the card asks for noise. For noise scenarios keep it realistic, not
  deafening: we want hard, not impossible.
- **If you go off-script, keep going.** Finish the call naturally and note what changed afterwards
  (see [section 10](#10-re-recording)). A natural call with a small change beats a stiff perfect one.
- **Stay near the target length.** Most calls land at 1-2 minutes. The kit hangs up at 5 minutes anyway.
- **At the hand-off, the rep stops talking** after the line, lets the customer answer, then ends the
  call within about 3 seconds.

---

## 9. The two Hinglish calls

These test code-switching: AssemblyAI is configured with `language_codes ["en","hi"]`, English first.

- **s19: Sunita (Hinglish customer) adds her son Arjun; the rep speaks only English.** The customer
  mixes Hindi and English the way people do at home: "Haan ji, mujhe apne bete ko policy mein add
  karna hai." The rep answers in English and politely asks again if a Hindi part is unclear. That's
  realistic and fine.
- **s20: Rohan and a bilingual rep (Aman).** Both code-switch. The rep opens in English (including
  "this call is recorded"), then follows the customer into Hinglish: "Theek hai, toh uske paas Texas
  ka full license hai ya abhi permit?"

**The one rule:** keep **every name, number, date, ZIP, policy number and dollar amount in English**,
said clearly: "date of birth hai *eighteenth June, two thousand nine*", "ZIP *zero-eight-eight-two-zero*".
Everything around them can be Hindi. Don't force Hindi into every sentence; switch where it feels natural.

---

## 10. Re-recording

**Re-record when:**

- a key fact came out wrong and wasn't corrected, e.g. the wrong date of birth,
- the hand-off never happened, or happened in the wrong place,
- a channel is silent or very quiet (see the warnings),
- the call dropped, or someone laughed and broke character for long.

**How:**

```powershell
.\kit mark s05_20260925T111203Z --discard --note "said the wrong DOB"
.\kit call --scenario s05 --rep me --customer volunteer1
```

The new take gets `take: 2` automatically. The eval uses the newest take marked **keep**, or else
the newest take that isn't discarded.

**Don't re-record for small drift. Record it instead.** If a fact came out slightly different from
the card but the call is otherwise good, keep it and write down what was actually said, so the
ground truth matches the audio:

```powershell
.\kit mark s02_20260925T101503Z --keep --override effective_date=2026-09-28 --note "said Monday instead of tomorrow"
.\kit mark s02_20260925T101503Z --status effective_date=VERIFIED --note "rep accidentally read the date back"
```

(`--override field=value` fixes a value. `--status field=VERIFIED|PENDING|MISSING` fixes what state
a fact was in at the hand-off. Field names are listed in `data/scenarios/README.md`.)

Budget: 1-2 re-takes per scenario at most. Each costs ~$0.20-0.30.

---

## 11. Checking a recording

Right after each call the kit prints something like:

```
Levels:
  rep       avg  -24.1 dBFS, peak  -6.0 dBFS, speech  41%, first sound at 0.4 s
  customer  avg  -26.3 dBFS, peak  -8.2 dBFS, speech  38%, first sound at 1.1 s
  both talking at once: 6% of talk time
No audio warnings.
```

**Then listen** (VLC, Windows Media Player, anything):

- `data\calls\split\<take>_rep.wav` should be only the rep's voice. The customer is silent or very faint.
- `data\calls\split\<take>_customer.wav` should be only the customer's voice.
- `data\calls\raw\<take>.wav` is stereo: rep on the left, customer on the right (default channel map).

| Warning | What it means | What to do |
|---|---|---|
| `... channel is nearly silent` | That phone's mic didn't pick up speech, or the channels are swapped | Listen. If the voices are just swapped: `.\kit split <take> --channel-map customer,rep`. If truly silent: re-record |
| `... clips` | Someone was too close to the mic or too loud | Keep it if it's still understandable; otherwise re-record with the phone a bit further away |
| `only N s long` | The call ended early | Usually re-record |
| `both channels active N% ...` | Heavy crosstalk, or both phones in the same room (audio bleed) | Expected in s06/s21. Anywhere else, move to separate rooms and re-record |
| `recording is MONO` | Twilio didn't record dual-channel | Shouldn't happen. Run `.\kit check` and tell the build session |

**Also check the facts.** Did everyone say what the card says? If not, record the difference
with `--override` ([section 10](#10-re-recording)).

**If the download failed** or you closed the terminal mid-call, nothing is lost: Twilio keeps the
recording. Run:

```powershell
.\kit list                                   # find the call
.\kit fetch CAxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx   # re-download + split (keeps the same take)
```

---

## 12. What to send back

**From volunteers:**

- their consent reply (A or B),
- anything they said differently from the card that you didn't catch.

**From you, at the end of the day:**

1. Run `.\kit report` and paste its output into the build session. It lists every take per scenario,
   the chosen take, duration, consent (public / private) and warnings, and writes
   `data\calls\manifest.json`.
2. Mention any scenario you skipped, and anything odd (echo, a call that sounded strange, a
   volunteer who switched to metrics-only).
3. **Don't upload or commit the audio.** `data/calls/` is git-ignored on purpose. The build pipeline
   reads the split WAVs directly from your laptop. Only takes where both people chose "public" may
   ever appear in the video or repo, and the sidecar's `consent.publishable` flag says which those are.
4. Optional, once everything is downloaded and checked: delete the recordings in the Twilio Console
   (its search box finds the "Recordings" page) to stop the small storage charge. The kit never
   deletes anything.

---

## 13. Troubleshooting

| Problem | Fix |
|---|---|
| The rep's phone never rings; kit says `failed` | Run `.\kit check`. Look at India geo permission, and in the Twilio Console Debugger for errors 13227 / 21215. Indian mobile ranges can be split across the Low-risk and High-risk tabs (Voice > Settings > Geo permissions) |
| Customer's phone never rings, or they don't answer | The kit reports `no-answer` / `busy` after 30 s. No recording is made and you only pay for your own leg. Check their number in `participants.json` (+91 and 10 digits) and that they're ready |
| Phone shows "International Call" / looks like spam | Normal for a +1 number in India. Save the number as a contact before the session |
| "refusing to dial without an interactive terminal" | Run the kit in your own PowerShell window, not from a script |
| `consent.recording is false` | Get their consent and update `participants.json` ([section 3](#3-consent-before-anyone-is-dialed)) |
| "balance ... below the safety floor" | Top up your Twilio balance |
| Both voices in both split files | The phones were in the same room. Separate rooms, re-record |
| Voices swapped between files | `.\kit split <take> --channel-map customer,rep` (no re-download needed) |
| "the recording was not ready after 4 minutes" | Wait a few minutes, then `.\kit fetch <CallSid>` |
| Terminal asks "Terminate batch job (Y/N)?" after Ctrl+C | Answer Y once the kit has printed its last message. The call was already hung up |
| `npm run kit -- ...` ignores your options in PowerShell | Use `.\kit ...` instead (PowerShell 5.1 can drop the `--`) |

---

## 14. Command cheat sheet

Run from `C:\Users\abid1\Desktop\assembly-ai\tools\recording-kit`:

```powershell
.\kit check                                               # read-only health check
.\kit scenarios                                           # list + validate the 22 scenarios
.\kit cards                                               # regenerate docs\role-cards.html/.md
.\kit call --scenario s01 --rep me --customer volunteer1 --dry-run   # rehearse, no call
.\kit call --scenario s01 --rep me --customer volunteer1             # record (type "call" to confirm)
.\kit call --scenario s01 --dial-first customer ...       # ring the customer first (customer = channel 1)
.\kit list                                                # recent recordings on Twilio
.\kit fetch <CallSid>                                     # re-download + split a recording
.\kit split <take> --channel-map customer,rep             # fix swapped channels locally
.\kit mark <take> --keep | --discard [--note "..."] [--override field=value] [--status field=STATUS]
.\kit report                                              # progress + data\calls\manifest.json
.\kit hangup <CallSid>                                    # emergency hang-up
.\kit selftest                                            # offline self-test
```

`<take>` is the file name without extension, e.g. `s01_20260925T101503Z`. A unique prefix like
`s01_2026` works too. More detail: `tools/recording-kit/README.md`. The scenario schema is in
`data/scenarios/README.md`.

---

## 15. Baton add-ons for today: s01 consent check and the "tail pack"

Two small extras from the build plan (`docs/DESIGN.md` §11.6, `docs/TASKS.md` §5). About 5 minutes and $0.25 in total.

**A. Before you record s01, check consent.** s01 is the call the demo video and the judges' default path are built on, so it must be publishable: **both** people who record s01 need `"scope": "public"` in `participants.json`. If nobody can be public, record s01 with a friend or family member who is happy to be public.

**B. Record the "tail pack" right after your kept s01 take.** In a normal take the rep hangs up about 3 seconds after the customer says yes, so the demo has no recording of these two voices after the hand-off. The tail pack fixes that: the AI half then answers in the customer's own voice, and "Daniel" comes back in his own voice if the customer asks for him.

1. Same two people, same roles as your kept s01 take:

   ```powershell
   .\kit call --scenario s01 --rep <same rep> --customer <same customer>
   ```

2. When the terminal shows **"BOTH CONNECTED - recording now"**, read the lines below **in order**, with about **one second of silence between lines**. Rep lines first, then customer lines. Natural voice, no need to act.

   **Rep (Daniel):**
   1. "Hi, it's Daniel again. I'm back on the line. What can I help with?"
   2. "Hi, Daniel here, I've got you back. Let me take care of that."
   3. "Okay, I'm back. Let's sort that out together."

   **Customer (Priya), general answers:**
   1. "Yes, that's right."
   2. "Yes, go ahead."
   3. "Yes, text me the link. No paper copy, thanks."
   4. "Okay, I'm paying now."
   5. "Okay, done, I've paid."
   6. "No, that's everything. Thanks, bye!"
   7. "Sure."
   8. "Sorry, could you repeat that?"
   9. "Can I talk to Daniel?"
   10. "Actually, she'll mainly drive the Highlander."

   **Customer (Priya), s01 answers:**
   1. "Her name is Maya Raman. M-A-Y-A."
   2. "She's my daughter."
   3. "March 14th, 2009. She's seventeen."
   4. "Ohio."
   5. "It's a probationary license. She passed last Tuesday."
   6. "No tickets, nothing."
   7. "She'll mainly drive the Civic."
   8. "Every day, to school."
   9. "It's parked at home, 4 4 1 0 7."
   10. "Next Friday, October 2nd."

3. Hang up, then mark it as a **discard** with the note `TAILPACK`, so it never enters the evaluation set but the build pipeline can find it:

   ```powershell
   .\kit mark <take> --discard --note "TAILPACK"
   ```

**C. Two things to say clearly in every take** (they are cut from the recording and replayed in the demo): the rep's hand-off line, followed by a short pause, and the customer's answer ("Sure, go ahead").

When you paste the `.\kit report` output into the build session, mention the tail-pack take name.
