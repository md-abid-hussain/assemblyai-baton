"use client";

/**
 * The org switcher (SAAS §8.2, §3.5). WP20·1.
 *
 * **What it does today and what it will do.** Switching is `authClient.organization.setActive()` followed by
 * `router.refresh()` (§3.5), and `auth-client` arrives with WP19·2. Until then this renders the real control
 * over the real list — which, under the C3 legacy principal, is genuinely one workspace — and the switch
 * handler is supplied by the caller. When `onSwitch` is absent the rows are plainly marked as not yet
 * switchable rather than silently doing nothing on click: a control that looks live and is not is worse than a
 * control that says so.
 *
 * "New organization" needs an account (§3.5), so a guest sees the §8.5 nudge instead of a dead button.
 */
import { BuildingIcon, CheckIcon, ChevronsUpDownIcon, PlusIcon } from "lucide-react";
import Link from "next/link";
import { useState, useTransition } from "react";

import type { OrgSummary } from "@/core/contracts/v3/identity";
import { PLANS } from "@/core/contracts/v3/plans";
import { cn } from "@/lib/utils";

import { Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from "./menu";

const KIND_LABEL: Record<OrgSummary["kind"], string> = {
  guest: "Guest workspace",
  personal: "Personal",
  team: "Team",
};

export interface OrgSwitcherProps {
  orgs: readonly OrgSummary[];
  activeId: string | null;
  /** WP20·2 passes the `setActive` + `router.refresh()` handler once `auth-client` exists. */
  onSwitch?: (orgId: string) => void | Promise<void>;
  /** False for a guest: "New organization" needs a real account (SAAS §3.5). */
  canCreateOrg?: boolean;
}

export function OrgSwitcher({ orgs, activeId, onSwitch, canCreateOrg = false }: OrgSwitcherProps) {
  const [pending, startTransition] = useTransition();
  const [busyId, setBusyId] = useState<string | null>(null);
  const active = orgs.find((o) => o.id === activeId) ?? orgs[0] ?? null;

  if (!active) {
    return <span className="text-muted-foreground text-sm">No workspace</span>;
  }

  const switchable = typeof onSwitch === "function";

  return (
    <Menu>
      <MenuTrigger
        className={cn(
          "hover:bg-accent flex max-w-[15rem] items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors",
          pending && "opacity-60",
        )}
        aria-label={`Workspace: ${active.name}. ${orgs.length} available.`}
      >
        <span className="bg-secondary text-secondary-foreground grid size-6 shrink-0 place-items-center rounded-md">
          <BuildingIcon className="size-3.5" aria-hidden="true" />
        </span>
        <span className="min-w-0 leading-tight">
          <span className="block truncate text-sm font-medium">{active.name}</span>
          <span className="text-muted-foreground block truncate text-[11px]">
            {PLANS[active.plan].name} · {KIND_LABEL[active.kind]}
          </span>
        </span>
        <ChevronsUpDownIcon className="text-muted-foreground size-3.5 shrink-0" aria-hidden="true" />
      </MenuTrigger>

      <MenuContent className="min-w-64">
        <MenuLabel>Workspaces</MenuLabel>
        {orgs.map((o) => (
          <MenuItem
            key={o.id}
            className="pl-8"
            disabled={!switchable && o.id !== active.id}
            onSelect={() => {
              if (!switchable || o.id === active.id) return;
              setBusyId(o.id);
              startTransition(async () => {
                await onSwitch(o.id);
                setBusyId(null);
              });
            }}
          >
            <span className="absolute left-2 flex size-4 items-center justify-center">
              {o.id === active.id ? <CheckIcon className="size-4" aria-hidden="true" /> : null}
            </span>
            <span className="min-w-0 flex-1 leading-tight">
              <span className="block truncate text-sm">{o.name}</span>
              <span className="text-muted-foreground block truncate text-[11px] capitalize">
                {o.role} · {PLANS[o.plan].name}
              </span>
            </span>
            {busyId === o.id ? <span className="text-muted-foreground text-[11px]">Switching…</span> : null}
          </MenuItem>
        ))}

        {!switchable && orgs.length > 1 ? (
          <p className="text-muted-foreground px-2 pt-1 pb-2 text-[11px]">Switching arrives with accounts.</p>
        ) : null}

        <MenuSeparator />
        {canCreateOrg ? (
          <MenuItem asChild>
            <Link href="/app/settings/organization?new=1">
              <PlusIcon className="size-4" aria-hidden="true" />
              New organization
            </Link>
          </MenuItem>
        ) : (
          <MenuItem asChild>
            <Link href="/sign-up?next=%2Fapp">
              <PlusIcon className="size-4" aria-hidden="true" />
              <span className="leading-tight">
                Create a free account
                <span className="text-muted-foreground block text-[11px]">to add more workspaces</span>
              </span>
            </Link>
          </MenuItem>
        )}
      </MenuContent>
    </Menu>
  );
}
