# WP7 → integrator (G2): the Baton console on the real controllers

Details: `docs/notes/wp7.md` "WP7·1 → What the integrator must do".

1. **Merge order.** `wp/wp7` contains `wp/wp5` (merged at `d407cfc`, WP5 tip `bd2e3c6` + main merge `8aa319a`).
   Merge `wp/wp5` first, then `wp/wp7`. No WP5 file was changed on `wp/wp7`.
2. **WP6 client swap** (WP7·2 will do it with the MockPhone mount if WP6 has merged by then): in
   `src/components/call/live-console.tsx`, pass `toolPorts` to `createBrowserControllers()` built from WP6's
   `createCallTool` / `createPaymentsClient`. The current stand-in (`src/client/session/tool-ports.ts`) speaks the same
   route #14/#15 contract.
3. **`/call/<s01>` needs WP9's call manifest and the server call lookup** (`[WIRE-CALLS]`), otherwise `/api/cases`
   cannot find the call.
4. **Env:** keep `PAY_TOOL_MODE=push`, `VA_KEYTERMS=1` on Zerops (the client's fallback compile and stage source use
   the same values).
