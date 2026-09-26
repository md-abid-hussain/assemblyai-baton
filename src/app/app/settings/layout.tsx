/**
 * The Settings layout (SAAS §8.2, §8.4). WP20·2.
 *
 * It renders the role-filtered sub-nav beside whichever panel is open, including the panels WP21, WP22, WP23 and
 * WP24 own — which is the reason it is a layout and not a component each of those pages has to remember to use.
 *
 * **It does not redirect**, for the same reason `/app/layout.tsx` does not: Next renders a layout and its page
 * concurrently, so a redirect here would race the page's and win with the wrong `?next=`. With no context it
 * renders the children bare and the page's own redirect is what the visitor gets.
 */
import type { Metadata } from "next";
import type * as React from "react";

import { visibleSettings } from "@/components/app-shell/nav";
import { SettingsNav } from "@/components/settings/settings-nav";
import { appContextOrNull } from "@/server/read-models/app-guard";

export const metadata: Metadata = { title: { default: "Settings", template: "%s · Settings · Changeover" } };

export const dynamic = "force-dynamic";

export default async function SettingsLayout({ children }: { children: React.ReactNode }) {
  const ctx = await appContextOrNull("/app/settings");
  if (!ctx) return <>{children}</>;

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,12rem)_minmax(0,1fr)] lg:gap-10">
      <SettingsNav items={visibleSettings(ctx.principal)} />
      <div className="min-w-0">{children}</div>
    </div>
  );
}
