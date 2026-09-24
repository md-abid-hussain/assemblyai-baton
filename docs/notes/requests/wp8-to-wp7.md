# WP8 → WP7 (QA card): how to consume verification

- **Poll** `GET /api/verifications/[takeoverId]` with the takeover token once the takeover has ended and
  `verificationJobId` is non-null. Poll every ~1.5 s: the route allows 1/s per takeover, and a 429 (with
  `Retry-After: 1`) is harmless, so ignore it. Each poll also advances the job when it is due (the Vercel mirror has no
  worker). Stop at `completed` or `failed`, or after ~150 s.
- **Response** `VerificationView {status, qa, elapsedMs, reason?}`:
  - `pending`: show the provisional numbers with a "verifying from recording…" hint.
  - `completed`: `qa` is the non-provisional `QaResult`. Show "✓ Verified from recording".
  - `failed`: `qa` is null and `reason` is a plain sentence. **Keep the provisional numbers** and show the reason
    small.
  - 404: there is no verification (no VA session). Keep the provisional numbers.
- **Measured live, poll-only** (docs/notes/wp8.md): about 22 s from the session end to `completed` (2 runs: 22.0 s and 21.9 s). S1 starts
  7 s after the end. With the webhook on Zerops, S3 does not wait for its 3 s poll.
- **Audio** (evidence chips / replay): `GET /api/va-sessions/[vaSessionId]/audio?t=<seconds>` with the takeover token
  → 302 to a pre-signed OGG (1 h TTL). `?t=12.5` becomes the media fragment `#t=12.5` on the redirect, because a query
  parameter would break the S3 signature. Use it as an `<audio src>` or `fetch` target. The route answers 404 +
  `Retry-After: 3` until the recording exists (about 4–7 s after the end), and 403 for another takeover's session.
