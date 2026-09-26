"use client";

/**
 * `/start` (SAAS §3.3). WP20·1.
 *
 * POST `/api/guest/start`, then `location.replace(next)`. Three things are deliberate:
 *
 * 1. **`replace`, not `push`.** `/start` must not sit in the history: a user pressing Back from `/app/runs`
 *    would bounce straight through it and land back on `/app/runs`.
 * 2. **A failure still continues.** WP19's endpoint does not exist before C3b, and after it a 429 is a
 *    *degrade*, not a block (§3.3 step 2) — on the judged URL a rate limit must never read like an outage. The
 *    device already has a signed `bvid` from `src/proxy.ts`, so the legacy workspace works either way.
 * 3. **`<noscript>` has a real button.** This is the only wall in the product, and it needs no input; it must
 *    not become a wall that a JS-less browser cannot climb.
 * 4. **It marks that it ran**, before navigating. `/api/guest/start` may legitimately come back degraded — no
 *    Better Auth on this deployment, or the §3.3 step 2 rate limit — and then `/app` still has no org. Without
 *    the marker, `/app` redirects here, this page comes back with no org, and `/app` redirects again: a loop
 *    on the judged URL, caused by a degradation the spec calls non-blocking. The guard reads the marker and
 *    renders the read-only device workspace instead of bouncing.
 */
import { useEffect, useRef, useState } from "react";

import { START_ATTEMPT_COOKIE } from "@/core/contracts/ext/wp20-app";

const SLOW_MS = 2500;

export function StartClient({ next }: { next: string }) {
  const [slow, setSlow] = useState(false);
  const done = useRef(false);

  useEffect(() => {
    if (done.current) return;
    done.current = true;

    const slowTimer = setTimeout(() => setSlow(true), SLOW_MS);
    const go = () => {
      clearTimeout(slowTimer);
      try {
        // Two minutes: long enough for the navigation, short enough that a later visit tries a real start again.
        document.cookie = `${START_ATTEMPT_COOKIE}=1; path=/; max-age=120; samesite=lax`;
      } catch {
        /* cookies disabled: /app falls back to its own redirect, which is the pre-existing behaviour */
      }
      window.location.replace(next);
    };

    void fetch("/api/guest/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ next }),
      credentials: "same-origin",
    })
      .catch(() => null)
      .then(go);

    return () => clearTimeout(slowTimer);
  }, [next]);

  return (
    <p aria-live="polite" className="text-muted-foreground text-sm">
      {slow ? "Almost there…" : "Setting up your guest workspace — no signup needed."}
    </p>
  );
}
