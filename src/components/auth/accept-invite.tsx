"use client";

/**
 * The accept button on `/accept-invite/[id]` (SAAS §3.6). WP20·2.
 *
 * Accepting is one of the §3.8 *reads* that stay on the Better Auth client: it is the invited person acting on
 * their own membership, not an org mutation performed on someone else. Better Auth checks that the session
 * user's email equals the invitation's, which is what makes "the link alone is not enough" true.
 *
 * After a successful accept the active org is the new one, so this is a full navigation for the same reason the
 * sign-in form is: every `/app` page is server-rendered through the principal, and the client cache still holds
 * the previous org's renders.
 */
import { useState } from "react";

import { acceptInvitation, isAuthFailure } from "@/client/app/auth-actions";

import { FormMessage } from "./fields";

export function AcceptInviteButton({ invitationId, orgName }: { invitationId: string; orgName: string }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onAccept() {
    if (pending) return;
    setPending(true);
    setError(null);
    const res = await acceptInvitation(invitationId);
    if (isAuthFailure(res)) {
      setPending(false);
      setError(res.message);
      return;
    }
    window.location.assign("/app");
  }

  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={() => void onAccept()}
        disabled={pending}
        className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex h-10 w-full items-center justify-center rounded-md text-sm font-medium transition-colors disabled:opacity-60"
      >
        {pending ? "Joining…" : `Join ${orgName}`}
      </button>
      <FormMessage tone="error">{error}</FormMessage>
    </div>
  );
}
