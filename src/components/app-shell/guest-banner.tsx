"use client";

/**
 * The guest banner (SAAS §8.2). WP20·1.
 *
 * Exact copy from the spec: "You're in a guest workspace. **Create a free account** to keep it — your relays and
 * runs come with you." Dismissible per session.
 *
 * **It renders on the server too.** The banner is server-rendered visible and only *hides* after mount if this
 * session dismissed it, rather than rendering nothing until `useEffect` runs. The other way round, a guest on a
 * slow connection sees the page reflow as the banner drops in — and the one sentence explaining that their work
 * is not saved yet is the last sentence that should arrive late.
 */
import { XIcon } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";

import { dismiss, DISMISS_GUEST_BANNER, isDismissed } from "@/client/app/session-dismiss";
import { cn } from "@/lib/utils";

export function GuestBanner({ next = "/app", className }: { next?: string; className?: string }) {
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    if (isDismissed(DISMISS_GUEST_BANNER)) setHidden(true);
  }, []);

  if (hidden) return null;

  return (
    <div
      className={cn(
        "border-b bg-[color-mix(in_oklch,var(--warning)_12%,var(--background))] px-[var(--cx-gutter)] py-2",
        className,
      )}
    >
      <div className="mx-auto flex max-w-[84rem] items-start gap-3">
        <p className="min-w-0 flex-1 text-sm text-pretty">
          You&rsquo;re in a guest workspace.{" "}
          <Link
            href={`/sign-up?next=${encodeURIComponent(next)}`}
            className="font-semibold underline underline-offset-2"
          >
            Create a free account
          </Link>{" "}
          to keep it — your relays and runs come with you.
        </p>
        <button
          type="button"
          onClick={() => {
            dismiss(DISMISS_GUEST_BANNER);
            setHidden(true);
          }}
          aria-label="Dismiss the guest workspace notice"
          className="hover:bg-accent -my-1 inline-flex size-7 shrink-0 items-center justify-center rounded-md"
        >
          <XIcon className="size-4" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
