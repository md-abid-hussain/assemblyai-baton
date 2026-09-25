# WP3 → WP4: answers to `wp4-to-wp3.md`, plus one ask

WP4's requests are all met:

1. **Order and idempotency.** #8 is idempotent on `(caseId, turnId)`.
   - A repeat returns 200 `skipped:"duplicate"` with the current state and that turn's stored events.
   - A repeat of a turn that is still being extracted waits for that extraction and returns its result, rather than
     a stale state.
2. **`after_takeover` is 200 with `skipped:"after_takeover"`, never a 409.**
   - An upstream luna failure is also 200: the current state with `events: []`, and the turn is stored with
     `extract_status='failed'`. So CaseSync's retry never re-triggers luna for it.
3. **Version.** Every response parses with `ExtractResponseSchema`. `state.version` increases by exactly 1 per
   committed extraction (it is saved under the case lock).
4. **Turn ids and sources** are validated with `TurnInputSchema`: a bad id, or a cached id without
   `source:"stt_cache"`, is 400. Fractional ms are stored as `double precision`; they are never rounded.
5. **`cachedTurnsUrl`** is `/data/cached-turns/<callId>.json` when `public/data/cached-turns/<callId>.json` exists,
   else `null`.
6. **Express.** The server inserts every cached final whose audio ended at or before `prefillUntilMs`
   (`endMs ≤ prefillUntilMs`), with its cached events, and makes no LLM call. It does not return the seed
   `agent_context`: your plan to read it from the cached-turns file stays.

**Ask: raise `requestTimeoutMs` from 15 s to 20 s.**
- The server's worst case for one turn is two luna attempts of 8.17 s each, plus the DB work, ≈ 16.6 s.
- With 15 s, a slow turn is retried by the client. The server then serves that retry from the in-flight extraction,
  so the result is correct but the request arrives late.
- Typical `extractMs`: p50 ≈ 2.1 s, p95 ≈ 3.4–4.1 s (measured locally; see docs/notes/wp3.md).

**Batching.** When more than 2 turns of a case are queued, the server sends them to luna together (≤3 per call).
- A one-in-flight CaseSync never triggers this, and that is intended.
- Measured on the s01 fixture: 3-turn batches found fewer labelled facts (7–9 of 10) than single turns (10/10,
  9/10, 10/10). Please do not pipeline requests to force batching.
