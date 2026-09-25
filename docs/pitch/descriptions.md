# lablab submission copy (v1)

**Version:** v1, 2026-09-25 (D1, WP13·1). Final at D5 18:00 (WP13·5), with the measured numbers from
`numbers.md` and every feature claim re-checked against the deployed app.

Paste the text inside each fenced block as-is. A unit test (`tests/unit/content/descriptions.test.ts`) checks the
lablab limits (title ≤ 50 characters, short ≤ 255 characters, long ≥ 100 words), that the short description names
the AssemblyAI products, and the wording rules in `positioning.md`.

## Title

```text
Changeover: reps start the call, AI finishes it
```

47 characters. The TASKS-v2 working title "Changeover: your rep starts the call, AI finishes it" is 52 characters, over
lablab's 50, so the submission uses this one. The landing page `<title>` keeps the longer form.

## Short description

```text
Changeover builds relay agents: human→AI handoff, mid-call. AssemblyAI Universal-3.5 Pro Realtime STT shadows the rep; on Pass the baton, the AssemblyAI Voice Agent API finishes the call without re-asking, and async transcription verifies it.
```

Names all three AssemblyAI products (P§12.2): Universal-3.5 Pro Realtime, the Voice Agent API, async transcription.

## Long description

```text
In the voice AI products we scanned, a call changes hands from AI to human, or from one AI to another: the AI agent gets stuck, a person takes over, and the customer often repeats everything. Service calls need the other direction. A person should handle the judgment part of the call, then hand the paperwork to an AI without the customer repeating a word. AssemblyAI's 2026 Voice Agent Insights Report found that 55% of end users say having to repeat themselves is what they hate most.

Changeover is a no-code studio for relay agents: human→AI handoff, mid-call. While the rep talks, AssemblyAI Universal-3.5 Pro Realtime transcribes each side of the call in its own session and builds an evidence-linked case, where every fact has a status and the audio clip it came from. When the rep presses Pass the baton, an AssemblyAI Voice Agent takes over already knowing what was said. It confirms only what is still open, fetches the required disclosure and reads it word for word, sends a payment link that counts as paid only when the payment provider says so, and closes the call. Afterwards, AssemblyAI async transcription of the AI half's own recording checks the disclosure and counts re-asked questions.

The flagship relay, Baton · insurance add-a-driver, runs on recorded role-play calls over a real phone line. In Changeover Studio you can open its blueprint, run gallery relays on simulated calls, try a one-click edit and hear the AI change, and publish a relay as a stored AssemblyAI agent.

Every run shows what is recorded, simulated or live. Customers and policies are fictional, payments use the Polar sandbox, and disclosures are samples, not legal advice. No signup and no mic: open the link and press Watch the handoff.
```

**Baton-first fallback (P§13.4).** If K-G3 fails and the Studio ships read-only, replace the third paragraph's
second sentence with: "In Changeover Studio you can open the blueprint behind Baton: the fields it tracks, what it
listens for, its handoff line and its playbook."

**Numbers to add at D5** (only from `numbers.md`, only if measured): after "counts re-asked questions", one sentence
such as "Across n runs over k distinct recorded takes, the AI re-asked … and read the disclosure at … similarity."

## Technology tags

```text
AssemblyAI, AssemblyAI Voice Agent API, Universal-3.5 Pro Realtime, AssemblyAI async transcription, OpenAI, Next.js, TypeScript, PostgreSQL, Drizzle ORM, Zerops, Polar, Twilio
```

- AssemblyAI Voice Agent API: the AI half (stored agents with HTTP tools on Publish, function tools in test runs).
- Universal-3.5 Pro Realtime: the shadow, one session per channel.
- AssemblyAI async transcription: multichannel verification of the AI half's recording.
- OpenAI: case extraction, relay drafting, and the voices of simulated calls (not the LLM Gateway, see `positioning.md`).
- Polar: sandbox payments. Twilio: only the offline recording kit for the role-play calls.

## Category tags

```text
Voice AI, Customer Service, Contact Center, Insurance, No-Code, Compliance
```

## Checklist before submitting (D5)

- [ ] Every number in the long description has a `numbers.md` row, and it is not `pending`.
- [ ] Every feature named in the long description works on the judged URL (Studio, Try an edit, Publish), or the
      Baton-first fallback sentence is in.
- [ ] Title, short and long pass `npm test` (`tests/unit/content/descriptions.test.ts`).
- [ ] The short description still names the three AssemblyAI products.
