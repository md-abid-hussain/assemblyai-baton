"use client";
/**
 * components/common/zod-jitless.tsx — turn off zod's JIT in the browser (QA-FIX, docs/notes/qa-fix.md).
 *
 * The adversarial QA pass found Firefox logging a CSP error on `/app`, `/call` and `/studio`:
 *
 *   Content-Security-Policy: … blocked a JavaScript eval … (Missing 'unsafe-eval')
 *
 * It is **not** Monaco (the report's guess) and nothing is broken by it: it is zod 4's feature probe,
 * `try { Function(""); … } catch { … }`, which decides whether to compile validators with the `Function`
 * constructor or to interpret them. Under our production CSP the probe always throws, zod always falls back, and
 * the app works — but the browser logs a hard red error on three of the four pages a judge opens, on a product
 * whose pitch includes "trust by design". A CSP violation nobody can explain is worth exactly as much as a bug.
 *
 * `jitless: true` tells zod not to try, so the probe never runs and the fallback path it would have taken
 * becomes the only path. Validation behaviour is identical (the JIT is a performance optimisation over the same
 * checks); the cost is a slightly slower parse in the browser, where we validate a handful of small API bodies.
 *
 * Only the client is configured: the server has no CSP, so its validators keep the JIT. This is a client
 * component rendered by the root layout so the setting is applied once, on every page, before any handler runs.
 */
import { config } from "zod";

config({ jitless: true });

export function ZodJitless() {
  return null;
}
