"use client";

/**
 * The user menu and the status pill (SAAS §8.2). WP20·1.
 *
 * Sign out is `authClient.signOut()`, which arrives with WP19·2; until then the menu shows the guest's real
 * options and no dead "Sign out" for someone who never signed in.
 */
import { LogOutIcon, UserIcon } from "lucide-react";
import Link from "next/link";

import type { ViewerSummary } from "@/core/contracts/ext/wp20-app";
import { cn } from "@/lib/utils";

import { Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from "./menu";

/** The v2 status pill: green while live AI calls are available, amber while the deployment is in replay mode. */
export function StatusPill({ text, live, className }: { text: string; live: boolean; className?: string }) {
  return (
    <span
      className={cn(
        "hidden items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium md:inline-flex",
        live
          ? "border-[var(--cx-ok)]/40 text-[var(--cx-ok)]"
          : "border-[var(--cx-warn)]/40 text-[var(--cx-warn)]",
        className,
      )}
    >
      <span
        aria-hidden="true"
        className={cn("size-1.5 rounded-full", live ? "bg-[var(--cx-ok)]" : "bg-[var(--cx-warn)]")}
      />
      {text}
    </span>
  );
}

export function UserMenu({ viewer, onSignOut }: { viewer: ViewerSummary; onSignOut?: () => void | Promise<void> }) {
  const initial = (viewer.name.trim()[0] ?? "?").toUpperCase();
  return (
    <Menu>
      <MenuTrigger
        className="hover:bg-accent flex items-center gap-2 rounded-full p-0.5 pr-2 transition-colors"
        aria-label={`Account menu for ${viewer.name}`}
      >
        <span className="bg-secondary text-secondary-foreground grid size-7 place-items-center rounded-full text-xs font-semibold">
          {initial}
        </span>
      </MenuTrigger>
      <MenuContent align="end">
        <MenuLabel>{viewer.isGuest ? "Guest" : "Signed in"}</MenuLabel>
        <div className="px-2 pb-2">
          <p className="truncate text-sm font-medium">{viewer.name}</p>
          <p className="text-muted-foreground truncate text-xs">
            {viewer.email ?? "No account yet — this workspace lives in this browser."}
          </p>
        </div>
        <MenuSeparator />
        {viewer.isGuest ? (
          <>
            <MenuItem asChild>
              <Link href="/sign-up?next=%2Fapp">Create account</Link>
            </MenuItem>
            <MenuItem asChild>
              <Link href="/sign-in?next=%2Fapp">Sign in</Link>
            </MenuItem>
          </>
        ) : (
          <>
            <MenuItem asChild>
              <Link href="/app/settings/profile">
                <UserIcon className="size-4" aria-hidden="true" />
                Profile
              </Link>
            </MenuItem>
            {onSignOut ? (
              <MenuItem onSelect={() => void onSignOut()}>
                <LogOutIcon className="size-4" aria-hidden="true" />
                Sign out
              </MenuItem>
            ) : null}
          </>
        )}
      </MenuContent>
    </Menu>
  );
}
