"use client";

/**
 * The shared-device claim card (SAAS §2.6 R1; a v3.1 item S§12 assigns to WP20). WP20·2.
 *
 * The HMAC on `bvid` binds the cookie to a **device**, not to a person. On a library PC, a demo laptop or a
 * borrowed browser, claiming automatically on sign-in would move the previous person's unclaimed guest work
 * into the next person's workspace. WP19 removed that automatic call; this card is the deliberate replacement,
 * and it is the only thing that can start a claim.
 *
 * **Three outcomes, and the difference between them matters:**
 *
 *  - **Add to this workspace** → `POST /api/app/claim-device`, which re-derives the visitor id from the signed
 *    cookie server-side (the body carries no id), re-checks the permission and audits `guest.claimed_device`;
 *  - **Not mine** → a permanent decline for this `(org, device)` pair. It is not the same as closing the card,
 *    and it does not delete anything: the legacy rows stay unclaimed and expire on their own schedule;
 *  - **×** → gone for this session only, because "not now" is a real answer and it is not a decision about
 *    whose data it is.
 *
 * The card names what it would move ("2 relays, 1 run") because "guest work" is not something anyone can
 * consent to. If the counts are wrong, the person looking at them is the one who can tell.
 */
import { XIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { claimDevice, declineClaim, isFailure } from "@/client/app/app-api";
import { dismiss, isDismissed } from "@/client/app/session-dismiss";
import { claimCountsSentence, type ClaimCardView } from "@/core/contracts/ext/wp20-app";

const DISMISS_KEY = "claim-card";

export function ClaimCard({ view }: { view: ClaimCardView }) {
  const router = useRouter();
  const [hidden, setHidden] = useState(false);
  const [pending, setPending] = useState<"add" | "decline" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    if (isDismissed(DISMISS_KEY)) setHidden(true);
  }, []);

  if (!view.offer || hidden) return null;

  async function onAdd() {
    if (pending) return;
    setPending("add");
    setError(null);
    const res = await claimDevice();
    setPending(null);
    if (isFailure(res)) {
      setError(res.message);
      return;
    }
    setDone("Added to this workspace.");
    router.refresh();
  }

  async function onDecline() {
    if (pending) return;
    setPending("decline");
    setError(null);
    const res = await declineClaim();
    setPending(null);
    if (isFailure(res)) {
      setError(res.message);
      return;
    }
    setHidden(true);
  }

  if (done) {
    return (
      <div role="status" className="border-[var(--cx-ok)]/40 bg-card rounded-xl border px-4 py-3">
        <p className="text-sm font-medium">{done}</p>
      </div>
    );
  }

  return (
    <div className="border-primary/30 bg-card rounded-xl border p-4 sm:p-5">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1 space-y-1">
          <p className="text-sm font-semibold text-balance">
            This browser has guest work that isn&rsquo;t in any workspace yet
          </p>
          <p className="text-muted-foreground max-w-prose text-sm text-pretty">
            {claimCountsSentence(view)} made here before you signed in. Add{" "}
            {view.relays + view.cases + view.drafts === 1 ? "it" : "them"} to{" "}
            <span className="text-foreground font-medium">{view.orgName}</span>?
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            dismiss(DISMISS_KEY);
            setHidden(true);
          }}
          aria-label="Not now — hide this until my next visit"
          className="hover:bg-accent -my-1 inline-flex size-7 shrink-0 items-center justify-center rounded-md"
        >
          <XIcon className="size-4" aria-hidden="true" />
        </button>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => void onAdd()}
          disabled={pending !== null}
          className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex h-9 items-center rounded-md px-4 text-sm font-medium transition-colors disabled:opacity-60"
        >
          {pending === "add" ? "Adding…" : "Add to this workspace"}
        </button>
        <button
          type="button"
          onClick={() => void onDecline()}
          disabled={pending !== null}
          className="hover:bg-accent inline-flex h-9 items-center rounded-md border px-4 text-sm font-medium transition-colors disabled:opacity-60"
        >
          {pending === "decline" ? "Saving…" : "Not mine"}
        </button>
        <details className="text-muted-foreground text-xs">
          <summary className="cursor-pointer underline underline-offset-4">What is this?</summary>
          <p className="mt-1.5 max-w-prose text-pretty">
            Anyone can try Changeover in a browser without signing up, and that work belongs to the browser
            rather than to a person. We never move it into an account automatically, because this browser may be
            shared. Choosing &ldquo;Not mine&rdquo; leaves it where it is and stops asking.
          </p>
        </details>
      </div>

      <div role="status" aria-live="polite" className="min-h-[1.25rem]">
        {error ? <p className="text-destructive mt-1 text-xs font-medium text-pretty">{error}</p> : null}
      </div>
    </div>
  );
}
