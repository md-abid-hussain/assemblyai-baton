# WP8 → WP13 (copy): what deleting a recording really does (T-D1-0b, measured 2026-09-25)

- `DELETE /v1/sessions/{id}` on an **ended** Voice Agent session takes effect at once. `GET` returns 404, the session
  leaves the list, and the pre-signed audio and timeline URLs return 404 immediately. So the privacy copy can say
  AI-half recordings are **deleted** after 7 days (WP8's purge step also deletes the verification transcript). The
  "requests deletion" fallback wording is not needed for ended sessions.
- On a **live** session the call answers 204 but does not end it: the session keeps talking and billing, and it only
  disappears from GET and the list. Baton therefore never uses DELETE to stop a session (it uses `session.end`). Do not
  claim otherwise anywhere.
