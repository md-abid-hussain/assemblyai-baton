"use client";

/**
 * The side nav (SAAS §8.2) and, at 390 px, the sheet it collapses into. WP20.
 *
 * Client-side only because the active item needs `usePathname`; everything else is static. The same `NAV` list
 * feeds both the rail and the sheet, so they can never disagree about what pages exist.
 */
import { ActivityIcon, BarChart3Icon, LayersIcon, MenuIcon, PlugZapIcon, SettingsIcon, XIcon } from "lucide-react";
import { Dialog } from "radix-ui";
import { usePathname } from "next/navigation";
import Link from "next/link";
import { useEffect, useState } from "react";

import { cn } from "@/lib/utils";

import { activeNavKey, NAV, type NavItem } from "./nav";

const ICONS = {
  layers: LayersIcon,
  activity: ActivityIcon,
  chart: BarChart3Icon,
  plug: PlugZapIcon,
  settings: SettingsIcon,
} as const;

function NavLink({ item, active, onNavigate }: { item: NavItem; active: boolean; onNavigate?: () => void }) {
  const Icon = ICONS[item.icon];
  return (
    <Link
      href={item.href}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm font-medium transition-colors",
        active
          ? "bg-secondary text-secondary-foreground"
          : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
      )}
    >
      <Icon className="size-4 shrink-0" aria-hidden="true" />
      {item.label}
    </Link>
  );
}

/** The permanent rail, from `lg` up. */
export function SideNav({ className }: { className?: string }) {
  const pathname = usePathname() ?? "/app";
  const active = activeNavKey(pathname);
  return (
    <nav aria-label="Sections" className={cn("space-y-0.5", className)}>
      {NAV.map((item) => (
        <NavLink key={item.key} item={item} active={item.key === active} />
      ))}
    </nav>
  );
}

/**
 * The same nav in a sheet, for narrow screens. It closes on navigation — an open sheet over the page you just
 * asked for is the classic mobile-nav bug.
 */
export function MobileNav() {
  const pathname = usePathname() ?? "/app";
  const [open, setOpen] = useState(false);
  const active = activeNavKey(pathname);

  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger
        className="hover:bg-accent inline-flex size-9 items-center justify-center rounded-md lg:hidden"
        aria-label="Open navigation"
      >
        <MenuIcon className="size-5" aria-hidden="true" />
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="data-[state=open]:animate-in data-[state=open]:fade-in-0 fixed inset-0 z-50 bg-black/50 lg:hidden" />
        <Dialog.Content
          className={cn(
            "bg-background fixed inset-y-0 left-0 z-50 flex w-[17rem] max-w-[85vw] flex-col gap-1 border-r p-3 shadow-xl lg:hidden",
            "data-[state=open]:animate-in data-[state=open]:slide-in-from-left",
          )}
        >
          <div className="flex items-center justify-between pb-2">
            <Dialog.Title className="px-1 text-sm font-semibold">Changeover</Dialog.Title>
            <Dialog.Close className="hover:bg-accent inline-flex size-8 items-center justify-center rounded-md" aria-label="Close navigation">
              <XIcon className="size-4" aria-hidden="true" />
            </Dialog.Close>
          </div>
          <Dialog.Description className="sr-only">Move between the sections of your workspace.</Dialog.Description>
          {NAV.map((item) => (
            <NavLink key={item.key} item={item} active={item.key === active} onNavigate={() => setOpen(false)} />
          ))}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
