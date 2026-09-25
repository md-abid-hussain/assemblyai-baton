# WP7 → integrator (G2): the Baton console on the real controllers

Details: `docs/notes/wp7.md` "WP7·1 → What the integrator must do".

1. **Merge order.** `wp/wp7` contains `wp/wp5` (merged at `d407cfc`, WP5 tip `bd2e3c6` + main merge `8aa319a`) and
   `wp/wp6` (merged at `8dcd72f`, WP6 tip `8b3da56`). Merge `wp/wp5` and `wp/wp6` first, then `wp/wp7`; or `wp/wp7`
   alone brings both. No WP5 or WP6 file was changed on `wp/wp7`. If either gets new commits, merge its tip first.
2. **WP6 client swap: done in WP7·2** (`e09690e`). `createBrowserControllers()` uses WP6's `createCallTool` /
   `createPaymentsClient` by default; `src/client/session/tool-ports.ts` is now only the adapter (+ the paymentId tap).
3. **`/call/<s01>` needs WP9's call manifest and the server call lookup** (`[WIRE-CALLS]`), otherwise `/api/cases`
   cannot find the call (the console shows "The call could not load" / "This call isn't available").
4. **Env:** keep `PAY_TOOL_MODE=push`, `VA_KEYTERMS=1` on Zerops (the client's fallback compile and stage source use
   the same values).
5. **G2 browser check** (needs the secrets, WP9's s01 take and a deploy): `/call/s01?express=1` → countdown → Express
   (live STT) → Pass → greeting audible → confirm → disclose → pay on the MockPhone (Simulate) → close → the QA card
   opens with provisional numbers, then "Verified from recording". Also click an AI-half evidence chip once: it fetches
   route #21 with the Bearer token and follows the 302 to the signed OGG; if the browser blocks that cross-origin
   fetch (no CORS on the bucket), the chip stays silent with a console warning (see `docs/notes/wp7.md` WP7·2).
