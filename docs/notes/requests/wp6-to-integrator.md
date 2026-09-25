# WP6 → integrator (G2)

1. **`DISCLOSURE_TAX_SUFFIX`** (DESIGN §5.8 "Tax"): add it to `src/server/env.ts` and `.env.example` as an optional
   flag, `"1"` = on, default off. `src/server/tools/wiring.ts` reads `process.env.DISCLOSURE_TAX_SUFFIX` directly
   until then. T-D1-9 shows it can stay off: Polar's `total_amount` equals the disclosed amount, and tax is 0.
2. **Polar settings (user, GUI; TASKS-v2 §11 D2):**
   - Add `https://app-2b25-3000.prg1.zerops.app` to the sandbox org's Settings → Embedding list. Add
     `http://localhost:3107` too, for the local lab.
   - Register the webhook `…/api/webhooks/polar` and set `POLAR_WEBHOOK_SECRET`.
   - Set `PAYMENTS_MODE=polar`, `POLAR_ACCESS_TOKEN`, `POLAR_PRODUCT_ID`, `POLAR_DEMO_CUSTOMERS`, `APP_URL` and
     `EMBED_ORIGINS`.

   Until the embed origin is listed, the phone falls back to the hosted link in about 5 s. Until the webhook is set,
   the server poll decides the status.
3. **`PAY_LAB`**: leave it unset on Zerops. `/pay/lab` is a dev page and 404s in production unless `PAY_LAB=1`.
4. **Local dev in a worktree:** `next dev --webpack -p <port>`. Turbopack refuses the `node_modules` junction. See
   docs/notes/wp6.md, WP6·1.
