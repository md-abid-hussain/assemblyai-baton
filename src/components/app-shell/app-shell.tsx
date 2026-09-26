/**
 * The `/app` chrome (SAAS §8.2). WP20·1.
 *
 * A server component: it takes already-loaded data and composes the client islands (switcher, nav, menu,
 * banner). Nothing here fetches, so every `/app` page controls its own waterfall.
 *
 * Layout: a sticky top bar, the guest banner under it, then a two-column body — a 15 rem rail from `lg` up, a
 * sheet below it. The content column is capped at 84 rem and has a 16 px gutter at every width, which is the
 * acceptance criterion for 390 px (TASKS-v3 §7 WP20 acceptance 6).
 */
import type * as React from "react";

import type { OrgSummary } from "@/core/contracts/v3/identity";
import type { ViewerSummary } from "@/core/contracts/ext/wp20-app";

import "./app-shell.css";
import { GuestBanner } from "./guest-banner";
import { LiveOrgSwitcher, LiveUserMenu } from "./shell-actions";
import { SideNav, MobileNav } from "./side-nav";
import { StatusPill } from "./user-menu";

export interface AppShellProps {
  viewer: ViewerSummary;
  orgs: readonly OrgSummary[];
  activeOrg: OrgSummary | null;
  statusText: string;
  statusLive: boolean;
  /** The path the guest banner's sign-up link returns to. */
  currentPath?: string;
  /**
   * `/start` ran and could not produce an account-backed workspace (SAAS §3.3 step 2). The page renders
   * read-only over the device workspace and says so in one quiet line. It must never read like an outage: on
   * the judged URL a rate limit that looks like downtime costs more than the limit saves.
   */
  degraded?: boolean;
  children: React.ReactNode;
}

export function AppShell({
  viewer,
  orgs,
  activeOrg,
  statusText,
  statusLive,
  currentPath = "/app",
  degraded = false,
  children,
}: AppShellProps) {
  return (
    <div className="cx-app bg-background text-foreground min-h-dvh">
      <a
        href="#cx-main"
        className="bg-background focus:ring-ring sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[60] focus:rounded-md focus:border focus:px-3 focus:py-2 focus:text-sm focus:ring-2"
      >
        Skip to content
      </a>

      <header className="bg-background/85 sticky top-0 z-40 border-b backdrop-blur-sm">
        <div className="mx-auto flex h-[var(--cx-bar-h)] max-w-[84rem] items-center gap-2 px-[var(--cx-gutter)]">
          <MobileNav />
          <a href="/app" className="shrink-0 text-sm font-semibold tracking-tight">
            Changeover
          </a>
          <span className="bg-border mx-1 hidden h-5 w-px sm:block" aria-hidden="true" />
          <LiveOrgSwitcher orgs={orgs} activeId={activeOrg?.id ?? null} canCreateOrg={!viewer.isGuest} />
          <div className="flex-1" />
          <StatusPill text={statusText} live={statusLive} />
          <a
            href="/docs"
            className="text-muted-foreground hover:text-foreground hidden px-2 text-sm font-medium sm:block"
          >
            Docs
          </a>
          <LiveUserMenu viewer={viewer} />
        </div>
      </header>

      {degraded ? (
        <p className="bg-muted/60 border-b px-[var(--cx-gutter)] py-2 text-center text-sm text-pretty">
          Continuing without a saved workspace — the demo works the same.{" "}
          <a href="/sign-up?next=%2Fapp" className="font-semibold underline underline-offset-2">
            Create a free account
          </a>{" "}
          (10 s) to keep your edits.
        </p>
      ) : viewer.isGuest ? (
        <GuestBanner next={currentPath} />
      ) : null}

      <div className="mx-auto flex max-w-[84rem] gap-6 px-[var(--cx-gutter)]">
        <aside className="hidden w-[var(--cx-nav-w)] shrink-0 py-6 lg:block">
          <SideNav className="sticky top-[calc(var(--cx-bar-h)+1.5rem)]" />
        </aside>
        <main id="cx-main" className="min-w-0 flex-1 py-6 pb-16">
          {children}
        </main>
      </div>
    </div>
  );
}
