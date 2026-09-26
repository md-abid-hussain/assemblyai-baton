"use client";

/**
 * The settings sub-nav (SAAS §8.2, §8.4). WP20·2.
 *
 * Two groups, *Workspace* and *Developers*, rendered from the one `SETTINGS_NAV` list the server already
 * filtered by role. Client-side only because the active row needs `usePathname`; the filtering itself is a
 * server decision and stays there, so the browser is never handed the list of pages this role may not open.
 *
 * At 390 px it becomes a horizontal, scrollable strip above the panel rather than a rail beside it. A rail on a
 * phone either eats half the width or hides the page; a strip keeps both the navigation and the content whole,
 * and `-mx-4 px-4` lets it bleed to the screen edge without the page itself gaining a scrollbar (acceptance 6).
 */
import Link from "next/link";
import { usePathname } from "next/navigation";

import { activeSettingsHref, SETTINGS_GROUPS, type SettingsItem } from "@/components/app-shell/nav";
import { cn } from "@/lib/utils";

export function SettingsNav({ items }: { items: readonly SettingsItem[] }) {
  const pathname = usePathname() ?? "";
  const active = activeSettingsHref(pathname);
  const groups = SETTINGS_GROUPS.filter((g) => items.some((s) => s.group === g));

  return (
    // `min-w-0` is load-bearing, not tidiness: a grid item defaults to `min-width: auto`, so without it the
    // track sizes to the strip's max-content width, the `overflow-x-auto` below never gets a narrower box to
    // scroll inside, and the whole page gains 410 px of horizontal scroll at 375 px. Found by measuring, not
    // by reading — the strip looks correct in isolation at every width.
    <nav aria-label="Settings" className="min-w-0 lg:sticky lg:top-20">
      {/* Phone: one scrollable strip, groups flattened — two headings above a strip is noise at that width. */}
      <div className="-mx-4 overflow-x-auto px-4 pb-1 lg:hidden">
        <ul className="flex w-max gap-1">
          {items.map((s) => (
            <li key={s.href}>
              <SettingsLink item={s} active={s.href === active} compact />
            </li>
          ))}
        </ul>
      </div>

      <div className="hidden lg:block lg:space-y-5">
        {groups.map((group) => (
          <div key={group} className="space-y-1">
            <p className="cx-eyebrow px-2.5">{group}</p>
            <ul className="space-y-0.5">
              {items
                .filter((s) => s.group === group)
                .map((s) => (
                  <li key={s.href}>
                    <SettingsLink item={s} active={s.href === active} />
                  </li>
                ))}
            </ul>
          </div>
        ))}
      </div>
    </nav>
  );
}

function SettingsLink({
  item,
  active,
  compact = false,
}: {
  item: SettingsItem;
  active: boolean;
  compact?: boolean;
}) {
  return (
    <Link
      href={item.href}
      aria-current={active ? "page" : undefined}
      className={cn(
        "block rounded-lg text-sm font-medium whitespace-nowrap transition-colors",
        compact ? "px-3 py-1.5" : "px-2.5 py-1.5",
        active
          ? "bg-secondary text-secondary-foreground"
          : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
      )}
    >
      {item.label}
    </Link>
  );
}
