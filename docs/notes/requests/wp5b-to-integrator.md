# WP5b → integrator (owner of `scripts/lib/**` after Wave 0)

## 1. Token-auth open in `scripts/lib/aai-open.ts` (for T-D1-3 part B)

T-D1-3 must prove that a Voice Agent socket opened with a **temp token** survives the token expiring during the
pre-update idle (a 5 s token, 8 s idle, then the first `session.update`). `openVoiceAgentNode` always
authenticates with the API-key header, and the boundaries test (correctly) forbids `.mintToken(` / `connectNode(`
anywhere else, so WP5b cannot run part B.

Requested (additive):

```ts
export interface OpenVoiceAgentOptions {
  // …existing…
  /** "header" (default): API key in Authorization. "token": mint a temp token (expiresInSeconds) and connect with ?token=. */
  auth?: { kind: "header" } | { kind: "token"; expiresInSeconds: number; /** wait this long between mint and connect */ connectDelayMs?: number };
}
```

Implementation: `new VoiceAgentRest(key).mintToken({ expiresInSeconds })`, then `connectNode({ token, … })` without
`apiKey`. Everything else (vaAcquire, ledger, heartbeat, report, release) unchanged. Then run:
`RUN_LIVE=1 npx tsx --conditions=react-server scripts/day1/va-t3-idle.ts` after switching its part B on (the script
has the part-A flow; part B = the same with `auth:{kind:"token",expiresInSeconds:5}` and `--idle-ms 8000`).

Until then: WP2 should mint the browser VA token with `expires_in_seconds` ≥ ~20–30 s (see `docs/notes/wp5b.md` §1).

## 2. G1/G2 wiring of the Voice Agent controller

See `docs/notes/wp5b.md` §5 ("What the integrator must wire").

---

## Integrator status (G1, 2026-09-25)

- §1 **done**: `openVoiceAgentNode({ auth: { kind: "token", expiresInSeconds, connectDelayMs?, restBase? } })` (two $0 unit tests). T-D1-3 part B is yours to run (live, ≈ $0.003).
- §2: G2 wiring (WP5/WP7/WP6/WP11); env defaults `PAY_TOOL_MODE=push` and `VA_KEYTERMS=1` set at G1.
Details: `docs/notes/g1.md` ("Integrator requests: disposition").
