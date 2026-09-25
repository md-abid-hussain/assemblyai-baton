# Changeover: positioning (v2.1)

**Version:** 2026-09-25 (D1, WP13·1), from `docs/PLATFORM.md` v2.1 §1, §11 and §12. Every public surface (landing,
README, slides, video, lablab copy) follows this page. Where this page and PLATFORM disagree, PLATFORM wins and this
page gets fixed.

## 1. The pitch

**One line:**

> **Changeover: build AI agents that finish what your people start.** Your rep handles the judgment part of the call.
> When they pass the baton, a relay agent already knows everything that was said, never asks twice, reads the required
> disclosure word for word, takes payment, and proves it from the recording.

**The 30-second version** (landing first viewport and video hook):

> **H1:** "Your rep starts the call. AI finishes it."
>
> **Subline:** "Changeover builds relay agents: human→AI handoff, mid-call. AssemblyAI Universal-3.5 Pro shadows your
> rep; press **Pass the baton** and an AssemblyAI Voice Agent takes over, already knowing everything that was said."

**Story order:** Baton leads, Changeover is underneath. The landing page, the video and the deck open on
**Baton · insurance add-a-driver** (recorded role-play, the strongest evidence), then show that Baton is one blueprint
in a studio anyone can use (the Dental relay, Try an edit, Publish).

**Why it matters, in one breath:** 55% of end users say having to repeat themselves is what they hate most (AssemblyAI
2026 Voice Agent Insights Report). A relay agent starts with what the customer already said.

## 2. Names

| Say | When | Never |
|---|---|---|
| **Changeover** | the product, app title, README H1, lablab title | "Changeover AI" in body copy; any shortening ("Change…") |
| **Baton · insurance add-a-driver** | the flagship relay, always in full | Baton as the product name |
| **relay agent** (lowercase "relay") | a blueprint-built agent that finishes a call; on first use on a page, paired with "human→AI handoff" | "bot", a capitalised "Relay" |
| **Pass the baton** | the handoff button in every relay | "Transfer" |
| **Changeover Studio** (`/studio`) | the builder | "Relay Studio", "Dashboard" |
| **blueprint** | the JSON a relay is made of | |
| **run** | one execution: recorded, simulated or published | |
| **recorded role-play** | Baton's human half: consented volunteers over a real phone line | "real call", "real customer" |
| **human half / AI half** | console, Studio, deck and video only | the landing's first viewport |
| **provenance strip** | the four-segment strip on every run | hiding "simulated" |

**First viewport rule:** at most three terms: Changeover, Pass the baton, relay agent (with "human→AI handoff").

## 3. What we claim, and how

| Claim | Wording | Never |
|---|---|---|
| The direction | "human → AI, mid-call: **not found in our market scan**" (only in the directions strip, slide 3 and the video's competition beat) | "first", "only", "no one else", "every builder hands off to humans" |
| Competitors | Name what they do, precisely: AI → human (warm transfer), AI → AI (squads), a human cues the AI (whisper, Live Call Control) | "competitors can't…" |
| Re-asks | "built not to re-ask; we count re-asks from the recording" until measured; then "re-asked X across n runs over k distinct recorded takes" | "never re-asks" as a measured fact before `numbers.md` has it |
| Disclosure | "read word for word; verified against the recording with async transcription" | "compliant", "legally compliant" |
| Money | "a payment counts only when the payment provider says so" | "the AI takes your card" |
| Metrics | "n runs over k distinct recorded takes", recorded takes only | "n calls" for n replays of one take; any metric from simulated calls |
| Simulated calls | say "simulated" every time one is on screen (voice-over, caption, provenance strip) | letting a sim pass as recorded |
| Freed rep time | only if s01 carries "I'll be one tap away if you need me" (see `numbers.md` rule 3); otherwise "one rep supervises N relays" is a roadmap rung | a freed-minutes number while the line is unconfirmed |
| Language models | "AssemblyAI's LLM Gateway requires a paid account; extraction and drafting use OpenAI directly behind one client, a base-URL swap away." | implying the Gateway is used |

Every number follows `numbers.md`. A number without a row there does not go out.

## 4. Where Changeover sits

| | Vapi / Retell / Synthflow / Bland / ElevenLabs Agents | **Changeover** |
|---|---|---|
| Unit you build | An agent that owns the whole call | A **relay**: a playbook the AI runs from the moment a human hands over |
| Handoff direction | AI → human (warm transfer), AI → AI (Vapi squads), a human cues the AI (Vapi whisper, Live Call Control) | **Human → AI, mid-call, with the context inherited** (not found in our market scan) |
| What the AI knows at handoff | What it collected itself | An **evidence-linked case**: every fact has a status and an audio clip from the human half, shadowed by AssemblyAI Realtime STT (one session per channel) |
| Compliance | The prompt says "read the disclosure" | The disclosure is fetched by a tool, stage-gated, read verbatim, and **verified from the recording** by async transcription |
| Money | Tools the LLM may call | **Fail-closed**: paid only when the provider says so |
| Proof | Call logs | A QA card from the recording: re-asked count, disclosure verbatim, audible latency |

Agent-assisted payment products (PCI Pal, Sycurio, Eckoh) keep the same human on the line and mask card entry; nothing
changes hands. The scan list and its sources are in `numbers.md` §5.

## 5. Buyer, value, price

**Buyer (wedge):** insurance servicing at independent agencies, MGAs and regional carriers. Endorsements: add a driver,
add a vehicle, address change, payment update. **Expand** with templates: healthcare front desks (deposits,
bookings), telecom (plan changes with e-sign), utilities (payment arrangements). **Channel:** CX agencies and BPOs
build relays for their clients.

**Why a buyer pays** (true whatever the rep says at the handoff):
1. **No re-asks:** the customer never repeats what they told the rep.
2. **Verbatim-disclosure proof on every AI-finished call**, from the recording, not from QA samples.
3. **After-call work removed:** the evidence-linked case record is the call note.
4. **Freed rep time:** only under `numbers.md` rule 3.

**Price (one sentence in the video and on slide 8):** "$0.30 per AI-finished minute; the relay studio is included."
It is a hypothesis (`numbers.md` N-headline-price), and the deck says so on the backup slide.

## 6. If the Studio ships read-only (Baton-first fallback, P§13.4)

Keep the H1 and Baton-first story. The secondary link becomes "See the blueprint behind Baton →", slide 4 shows the
blueprint and relay track read-only, and the long description uses the fallback sentence in `descriptions.md`. Never
show a half-working Studio on the judged URL.

## 7. Where the copy lives

| Surface | File | Owner |
|---|---|---|
| Landing and "how it works" copy | `src/content/landing.ts`, `src/content/about.ts`, `src/content/field-notes.ts` | WP13 (WP7b renders) |
| Numbers shown in the app | `src/content/numbers.ts` (mirrors `docs/pitch/numbers.md`) | WP13 |
| lablab title, descriptions, tags | `docs/pitch/descriptions.md` | WP13 |
| Numbers sheet | `docs/pitch/numbers.md` | WP13 |
| Video script, shot list, slides | `docs/pitch/{video-script,shot-list,slides}.md` (D2–D3) | WP13 |
