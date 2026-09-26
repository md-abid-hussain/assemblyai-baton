"use client";
/**
 * components/marketing/status-pill.tsx - the landing's status pill (P§12.1), fed by `GET /api/status`.
 *
 * It renders the "unknown" wording first and upgrades on the answer, so the landing page is a pure static render
 * that never waits on the API — WP7b acceptance 1 is that `/` still renders when `/api/status` is down, and the
 * cheapest way to guarantee that is for the server render never to call it.
 */
import { useEffect, useState } from "react";

import { statusPillText, type PillStatus, type StatusPillCopy } from "@/content";

export function StatusPill({ copy }: { copy: StatusPillCopy }) {
  const [status, setStatus] = useState<PillStatus | null>(null);

  useEffect(() => {
    const ac = new AbortController();
    void (async () => {
      try {
        const res = await fetch("/api/status", { signal: ac.signal, headers: { accept: "application/json" } });
        if (!res.ok) return;
        const body = (await res.json()) as { aiHalfAvailable?: unknown; nextLiveAt?: unknown };
        if (typeof body.aiHalfAvailable !== "boolean") return;
        setStatus({
          aiHalfAvailable: body.aiHalfAvailable,
          nextLiveAt: typeof body.nextLiveAt === "string" ? body.nextLiveAt : null,
        });
      } catch {
        // The pill keeps its "status unavailable" wording; nothing else on the page depends on this.
      }
    })();
    return () => ac.abort();
  }, []);

  return (
    <span
      role="status"
      className="border-border bg-muted/50 text-muted-foreground inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs"
    >
      <span
        aria-hidden="true"
        className={`size-1.5 rounded-full ${status?.aiHalfAvailable ? "bg-emerald-500" : "bg-amber-500"}`}
      />
      {statusPillText(copy, status)}
    </span>
  );
}
