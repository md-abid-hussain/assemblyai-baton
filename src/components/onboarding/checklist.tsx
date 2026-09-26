"use client";

/**
 * The `/app` checklist (SAAS §8.3). WP20·1.
 *
 * It is the judge path (§13.1), so it is the first thing on the overview and every item deep-links to the
 * screen that completes it. Dismissible per session, like the guest banner — a returning user who already knows
 * the product should not have to scroll past the tutorial every time.
 *
 * An item that cannot be done yet shows *why* instead of a link that would bounce off an
 * `E_ACCOUNT_REQUIRED`: SAAS §8.5's rule is to show the real surface and offer the ten-second account, never to
 * refuse.
 */
import { CheckIcon, ChevronRightIcon, LockIcon } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";

import { dismiss, DISMISS_CHECKLIST, isDismissed } from "@/client/app/session-dismiss";
import type { ChecklistItemView } from "@/core/contracts/ext/wp20-app";
import { cn } from "@/lib/utils";

export function Checklist({ items, className }: { items: readonly ChecklistItemView[]; className?: string }) {
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    if (isDismissed(DISMISS_CHECKLIST)) setHidden(true);
  }, []);
  if (hidden || items.length === 0) return null;

  const done = items.filter((i) => i.done).length;

  return (
    <section
      className={cn("bg-card overflow-hidden rounded-xl border", className)}
      aria-labelledby="cx-checklist-title"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 pt-3.5 pb-2">
        <div>
          <h2 id="cx-checklist-title" className="text-sm font-semibold">
            Get the whole product working
          </h2>
          <p className="text-muted-foreground cx-num text-xs">
            {done} of {items.length} done
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            dismiss(DISMISS_CHECKLIST);
            setHidden(true);
          }}
          className="text-muted-foreground hover:text-foreground text-xs font-medium"
        >
          Hide
        </button>
      </div>

      <div className="bg-muted mx-4 mb-3 h-1 overflow-hidden rounded-full" aria-hidden="true">
        <div
          className="bg-foreground/70 h-full rounded-full transition-[width] duration-500"
          style={{ width: `${Math.round((done / items.length) * 100)}%` }}
        />
      </div>

      <ol className="divide-y border-t">
        {items.map((item) => (
          <li key={item.id}>
            <Link
              href={item.href}
              className="hover:bg-accent/50 flex items-center gap-3 px-4 py-2.5 transition-colors"
            >
              <span
                aria-hidden="true"
                className={cn(
                  "grid size-5 shrink-0 place-items-center rounded-full border",
                  item.done
                    ? "border-transparent bg-[var(--cx-ok)] text-white"
                    : item.blockedReason
                      ? "text-muted-foreground border-dashed"
                      : "border-border",
                )}
              >
                {item.done ? (
                  <CheckIcon className="size-3" strokeWidth={3} />
                ) : item.blockedReason ? (
                  <LockIcon className="size-2.5" />
                ) : null}
              </span>
              <span className="min-w-0 flex-1">
                <span className={cn("block text-sm", item.done && "text-muted-foreground line-through")}>
                  {item.label}
                </span>
                {item.blockedReason ? (
                  <span className="text-muted-foreground block text-xs">{item.blockedReason}</span>
                ) : null}
              </span>
              <span className="sr-only">{item.done ? "Done" : "Not done yet"}</span>
              <ChevronRightIcon className="text-muted-foreground size-4 shrink-0" aria-hidden="true" />
            </Link>
          </li>
        ))}
      </ol>
    </section>
  );
}
