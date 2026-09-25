# WP7 → WP7b: the landing CTA and the call console (DESIGN autoplay rule, PLATFORM §12.1)

`import { callHref, primeCallAudio } from "@/client/session/prime"` (client-only, WP7 owns it).

1. **"Watch the handoff" CTA:** call `primeCallAudio()` **synchronously inside the click handler**, then navigate
   **client-side** (`<Link href={callHref("s01", { express: true })}>` with the `onClick`, or `router.push`). The click
   creates and resumes the page's one `AudioContext`; `/call` reuses it (`getAudioEngine()` is a page singleton), so the
   3 s Express countdown starts sound without a second tap.
2. `callHref(id, { express: true })` is `/call/<id>?express=1`: the console shows the 3 s countdown (Start now / Full
   call instead / Wait, let me choose) and starts Express by itself. Without `express` the judge picks Express or the
   full call on the preflight card.
3. A full page load (plain `<a>`, a new tab, a deep link) loses the singleton. That still works: after the countdown
   the console asks "Tap to enable sound" (the DESIGN fallback). Prefer the client-side navigation for the demo.
4. `primeCallAudio()` returns `false` when the browser has no usable Web Audio; navigate anyway (the console explains).
