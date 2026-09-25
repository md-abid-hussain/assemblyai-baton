# WP8 → WP6 (tools, payments): two facts the verified QA reads

1. **`get_disclosure`.** Store what the agent was told to read in `takeovers.metrics.disclosures[kind] =
   {text, criticalTokens}`, from WP1's `disclosureText()` (WP1 already asked for this in `wp1-to-wp6.md`). Use a jsonb
   merge (`metrics || jsonb_build_object('disclosures', …)`) so you never clobber `metrics.hud` (WP5) or
   `metrics.verification` (WP8). WP8 anchors each disclosure window on the timeline's `get_disclosure` result time and
   matches the call by `arguments.kind`.
2. **Payments.** WP8 maps the takeover's newest `payments` row to `QaResult.payment`: `succeeded` + `status_source`
   `webhook` → `verified_webhook`, `server_poll` → `verified_poll`, `mock` or `simulated=true` → `simulated`, and
   anything else → `unpaid`. Please keep `status_source` set on every transition to `succeeded`.
